// do.md "online presence indicator", Gateway side.
//
// The bug under test is not "the dot is the wrong colour". It is that the
// presence WRITE PATH had never once succeeded, silently, while looking
// indistinguishable from a user who was never online.
//
// Evidence that produced this file, measured against production before the fix:
//
//     GET /api/profiles?select=username,created_at,last_seen_at
//     -> 28 of 29 profiles had last_seen_at exactly equal to created_at
//
// `created_at` equality means the value is the column's INSERT default, so the
// row had never been updated by anything. The old writer was the database
// function `update_last_seen()`, reached through `gateway.rpc()`, and both of its
// silent failure modes were open at once:
//
//   - `auth.uid()` is read from the request JWT inside PostgREST. If it does not
//     resolve, the UPDATE matches zero rows and PostgREST answers 204. Success,
//     writing nothing.
//   - if the function is absent from the deployed database, the gateway maps the
//     upstream 404 to 400 - and the caller discarded `error`.
//
// So the write is asserted here in three layers, worst first:
//
//   1. The write itself. It stamps `last_seen_at` for the CALLER's id, taken from
//      the verified token. It must not consult auth.uid(), must not depend on a
//      database function, and must report `updated: 0` rather than claim success,
//      because collapsing those two is the invisibility being removed.
//   2. Identity. A body-supplied user id must be ignored, so a signed-in user
//      cannot mark somebody else online. That is the one place a convenience
//      would be a security hole.
//   3. The route. Auth required, not cacheable, and 'no writable project'
//      distinguishable from 'write failed'.
//
// Run: npm run test:presence
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { router } from '../api/routes';
import { projectManager } from '../project-manager';
import {
  PRESENCE_LOGGED_OUT_AT,
  PRESENCE_PROFILE_DOMAINS,
  writePresenceHeartbeat,
  writePresenceLogout,
  type PresenceClient,
  type PresenceWriteDeps,
} from './presence';

const USER = 'user-abc';
const AT = '2026-09-29T12:00:00.000Z';

interface RecordedUpdate {
  table: string;
  values: Record<string, unknown>;
  filters: Array<[string, unknown]>;
  selected: string | null;
}

/**
 * A recording stand-in for the service-role client. Models only the four calls
 * the write makes, and records them so a test can assert the shape of the query
 * rather than just that it did not throw.
 */
function recordingClient(
  result: { data?: unknown[]; error?: { message: string } | null } | 'throws',
): { client: PresenceClient; calls: RecordedUpdate[] } {
  const calls: RecordedUpdate[] = [];
  const client: PresenceClient = {
    from(table: string) {
      const call: RecordedUpdate = { table, values: {}, filters: [], selected: null };
      const builder: Record<string, unknown> = {
        update(values: Record<string, unknown>) {
          call.values = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        select(columns: string) {
          call.selected = columns;
          return Promise.resolve(
            result === 'throws'
              ? Promise.reject(new Error('socket hang up')).then((v: unknown) => v)
              : result,
          );
        },
      };
      calls.push(call);
      return builder;
    },
  };
  return { client, calls };
}

function depsFor(client: PresenceClient | null, on = 'profiles'): PresenceWriteDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getWritableClient(domain: string) {
      asked.push(domain);
      return domain === on ? client : null;
    },
  };
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. The write
  // -------------------------------------------------------------------------
  {
    const { client, calls } = recordingClient({ data: [{ id: USER }] });
    const outcome = await writePresenceHeartbeat(USER, depsFor(client), () => new Date(AT));

    assert.equal(outcome.status, 'written', 'a successful write must report `written`');
    assert.equal(outcome.status === 'written' && outcome.updated, 1,
      'one caller, one row: the write must report the row it actually wrote');
    assert.equal(outcome.status === 'written' && outcome.lastSeenAt, AT,
      'the returned timestamp must be the one that was written, not a fresh clock read');

    assert.equal(calls.length, 1, 'exactly one query: a heartbeat is not a batch');
    assert.equal(calls[0].table, 'profiles',
      'it must write the existing presence column, not introduce a second store');
    assert.deepEqual(calls[0].values, { last_seen_at: AT },
      'last_seen_at is the presence source every reader already uses');
    assert.deepEqual(calls[0].filters, [['id', USER]],
      'the row must be matched on the verified caller id - a primary key match, one row');
    assert.equal(calls[0].selected, 'id',
      '`.select()` is what makes `updated` know whether a row was really written');
  }

  // The value written must be an ISO-8601 instant, because that is the shape
  // every reader parses with `new Date(...)` on the way to the dot.
  {
    const { client, calls } = recordingClient({ data: [{ id: USER }] });
    const outcome = await writePresenceHeartbeat(USER, depsFor(client), () => new Date(AT));
    const written = calls[0].values['last_seen_at'] as string;
    assert.equal(written, AT);
    assert.equal(new Date(written).getTime(), new Date(AT).getTime(),
      'the written value must round-trip through the reader\'s parser');
    assert.ok(outcome.status === 'written');
  }

  // `updated: 0` must survive as its own outcome. This is the assertion that
  // pins the original failure mode shut: reporting success for a write that
  // matched nothing is exactly how a dead heartbeat looked like an idle user.
  {
    const { client } = recordingClient({ data: [] });
    const outcome = await writePresenceHeartbeat(USER, depsFor(client), () => new Date(AT));
    assert.equal(outcome.status, 'written', 'no rows written is still a completed write');
    assert.equal(outcome.status === 'written' && outcome.updated, 0,
      'zero rows must be reported as zero, not folded into success');
  }

  // A rejected write is a failure, and is not confused with the above.
  {
    const { client } = recordingClient({ error: { message: 'permission denied for table profiles' } });
    const outcome = await writePresenceHeartbeat(USER, depsFor(client), () => new Date(AT));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.status === 'failed' && outcome.message, 'permission denied for table profiles',
      'the reason must survive to the caller for logging');
  }

  // A client that throws must not take the route down with an unhandled rejection.
  {
    const { client } = recordingClient('throws');
    const outcome = await writePresenceHeartbeat(USER, depsFor(client), () => new Date(AT));
    assert.equal(outcome.status, 'failed', 'a transport throw is a failed write, not a crash');
  }

  // An empty caller id must be refused outright. The route reads the id off the
  // verified request, so an empty id means the route's own guard was bypassed;
  // writing a row anyway would be a write to an arbitrary id.
  {
    const { client, calls } = recordingClient({ data: [{ id: USER }] });
    for (const bad of ['', undefined as unknown as string, null as unknown as string]) {
      const outcome = await writePresenceHeartbeat(bad, depsFor(client), () => new Date(AT));
      assert.equal(outcome.status, 'failed', `caller id ${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(calls.length, 0, 'a refused heartbeat must not touch the database at all');
  }

  // -------------------------------------------------------------------------
  // 2. Project resolution
  // -------------------------------------------------------------------------
  {
    assert.deepEqual([...PRESENCE_PROFILE_DOMAINS], ['profiles', 'users'],
      'the domain order must prefer the dedicated host and fall back to `users`, ' +
      'matching every other service-role reader in this gateway');

    const { client } = recordingClient({ data: [{ id: USER }] });
    const deps = depsFor(client, 'users');
    const outcome = await writePresenceHeartbeat(USER, deps, () => new Date(AT));
    assert.equal(outcome.status, 'written', 'the users host must still be able to serve the write');
    assert.deepEqual(deps.asked, ['profiles', 'users'],
      'the dedicated domain must be tried before the fallback');
  }

  {
    const deps = depsFor(null);
    const outcome = await writePresenceHeartbeat(USER, deps, () => new Date(AT));
    assert.equal(outcome.status, 'no-client',
      'no writable project must be its own outcome, so the route can answer 503 ' +
      'rather than pretending a write happened');
  }

  // -------------------------------------------------------------------------
  // 3. The route: auth, identity, cache headers
  // -------------------------------------------------------------------------
  const originalGetWritableProject = projectManager.getWritableProject.bind(projectManager);
  const originalVerifyToken = (projectManager as any).__unused;
  void originalVerifyToken;

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const writes: RecordedUpdate[] = [];
  const stubClient: PresenceClient = {
    from(table: string) {
      const call: RecordedUpdate = { table, values: {}, filters: [], selected: null };
      const builder: Record<string, unknown> = {
        update(values: Record<string, unknown>) { call.values = values; return builder; },
        eq(column: string, value: unknown) { call.filters.push([column, value]); return builder; },
        select(columns: string) {
          call.selected = columns;
          writes.push(call);
          return Promise.resolve({ data: [{ id: 'someone' }], error: null });
        },
      };
      return builder;
    },
  };

  try {
    // No bearer token at all.
    {
      projectManager.getWritableProject = (() => ({ client: stubClient })) as any;
      const res = await fetch(`${base}/api/presence/heartbeat`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      assert.equal(res.status, 401, 'presence must require the caller\'s own session');
      assert.equal(writes.length, 0, 'an unauthenticated request must write nothing');
      assert.equal(body.updated, undefined, 'and must not report a write');
    }

    // A garbage token must not be treated as a guest who is allowed to write.
    {
      const before = writes.length;
      const res = await fetch(`${base}/api/presence/heartbeat`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not.a.real.jwt' },
      });
      assert.equal(res.status, 401, 'an invalid token must 401, not fall through to a write');
      assert.equal(writes.length, before, 'and must still write nothing');
    }

    // A request that names a DIFFERENT user in its body must still write the
    // caller's own row. This is the assertion that keeps the endpoint from
    // becoming a presence-spoofing primitive: the id comes from the token, so
    // the body is never consulted.
    {
      writes.length = 0;
      // Stub the token verifier so `auth.authenticate` accepts a fixed subject.
      const authModule = await import('../auth');
      const originalVerify = authModule.auth.verifyToken;
      (authModule.auth as any).verifyToken = async (token: string) =>
        token === 'good' ? { id: USER } : null;
      try {
        projectManager.getWritableProject = (() => ({ client: stubClient })) as any;
        const res = await fetch(`${base}/api/presence/heartbeat`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer good',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: 'someone-else', id: 'someone-else' }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
        assert.equal(body.ok, true);
        assert.equal(writes.length, 1, 'exactly one row written');
        assert.deepEqual(writes[0].filters, [['id', USER]],
          'the written row must be the VERIFIED caller, never a body-supplied id');
        assert.notEqual(writes[0].filters[0][1], 'someone-else',
          'a body-supplied user_id must never reach the write');
        assert.equal(res.headers.get('cache-control'), 'no-store',
          'a cached heartbeat would report "you are online" for as long as the entry lived');
      } finally {
        (authModule.auth as any).verifyToken = originalVerify;
      }
    }

    // No writable project -> 503, and explicitly NOT a 200 that claims a write.
    {
      const authModule = await import('../auth');
      const originalVerify = authModule.auth.verifyToken;
      (authModule.auth as any).verifyToken = async () => ({ id: USER });
      try {
        projectManager.getWritableProject = (() => null) as any;
        const res = await fetch(`${base}/api/presence/heartbeat`, {
          method: 'POST',
          headers: { Authorization: 'Bearer good' },
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        assert.equal(res.status, 503, 'a missing writable project is a deployment fault, not a success');
        assert.equal(body.updated, undefined, 'and must not report rows written');
        assert.equal(res.headers.get('cache-control'), 'no-store');
      } finally {
        (authModule.auth as any).verifyToken = originalVerify;
      }
    }

    // -----------------------------------------------------------------------
    // The logout endpoint, over HTTP
    // -----------------------------------------------------------------------
    // Unauthenticated: must write nothing. This is the assertion that matters
    // most for logout, because an unauthenticated caller being allowed through
    // would mean anyone could mark a stranger offline by guessing an id.
    {
      writes.length = 0;
      projectManager.getWritableProject = (() => ({ client: stubClient })) as any;
      const res = await fetch(`${base}/api/presence/logout`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      assert.equal(res.status, 401, 'presence removal must require the caller\'s own session');
      assert.equal(writes.length, 0, 'an unauthenticated logout must write nothing');
      assert.equal(body.updated, undefined, 'and must not report a write');
    }

    {
      const authModule = await import('../auth');
      const originalVerify = authModule.auth.verifyToken;
      (authModule.auth as any).verifyToken = async (token: string) =>
        token === 'good' ? { id: USER } : null;
      try {
        projectManager.getWritableProject = (() => ({ client: stubClient })) as any;

        // A body-supplied id must be ignored, in the offline direction too.
        {
          writes.length = 0;
          const res = await fetch(`${base}/api/presence/logout`, {
            method: 'POST',
            headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 'victim', id: 'victim' }),
          });
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
          assert.equal(writes.length, 1);
          assert.deepEqual(writes[0].filters, [['id', USER]],
            'the row marked offline must be the VERIFIED caller, never a body-supplied id');
          assert.notEqual(writes[0].filters[0][1], 'victim',
            'a body-supplied user_id must never reach the logout write');
          assert.equal(writes[0].values['last_seen_at'], PRESENCE_LOGGED_OUT_AT,
            'the response path must write the explicit offline marker');
          assert.equal(body.ok, true);
          assert.equal(body.last_seen_at, PRESENCE_LOGGED_OUT_AT,
            'the response must report the marker it wrote, so the client can verify it');
          assert.equal(res.headers.get('cache-control'), 'no-store',
            'a cached logout would outlive the presence it removed');
        }

        // An invalid token must not be treated as an allowed caller.
        {
          writes.length = 0;
          const res = await fetch(`${base}/api/presence/logout`, {
            method: 'POST',
            headers: { Authorization: 'Bearer not.a.real.jwt' },
          });
          assert.equal(res.status, 401, 'an invalid token must 401, not fall through to a write');
          assert.equal(writes.length, 0, 'and must still write nothing');
        }

        // No writable project -> 503, never a 200 claiming a removal.
        {
          writes.length = 0;
          projectManager.getWritableProject = (() => null) as any;
          const res = await fetch(`${base}/api/presence/logout`, {
            method: 'POST',
            headers: { Authorization: 'Bearer good' },
          });
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          assert.equal(res.status, 503, 'a missing writable project is a deployment fault, not a success');
          assert.equal(body.updated, undefined, 'and must not report rows written');
          assert.equal(res.headers.get('cache-control'), 'no-store');
        }
      } finally {
        (authModule.auth as any).verifyToken = originalVerify;
      }
    }
  } finally {
    projectManager.getWritableProject = originalGetWritableProject;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // -------------------------------------------------------------------------
  // 4. Explicit sign-out removes presence
  // -------------------------------------------------------------------------
  //
  // The reported bug: two users online, both green, User A logs out, and B keeps
  // seeing A green. The cause is that sign-out wrote NOTHING about presence - the
  // row kept the timestamp from the last heartbeat, `isOnline()` kept answering
  // true for the rest of the freshness window, and nothing errored. So the write
  // is asserted here rather than the timeout being shortened.
  {
    const { client, calls } = recordingClient({ data: [{ id: USER }] });
    const outcome = await writePresenceLogout(USER, depsFor(client));

    assert.equal(outcome.status, 'written');
    assert.equal(outcome.status === 'written' && outcome.updated, 1);
    assert.equal(calls.length, 1, 'one caller, one row - a logout is not a batch');
    assert.equal(calls[0].table, 'profiles',
      'it must write the EXISTING presence column, not a second store');
    assert.deepEqual(calls[0].filters, [['id', USER]],
      'only the caller\'s own row may be marked offline');
    assert.deepEqual(calls[0].values, { last_seen_at: PRESENCE_LOGGED_OUT_AT });
  }

  // The marker must NOT be `null`, because the reader treats a null as a
  // REDACTED presence (non-friend + pending message request) and deliberately
  // refuses to overwrite the held value with it. A null here would be dropped by
  // the reader and the dot would stay green - the same bug, wearing a new hat.
  {
    const { client, calls } = recordingClient({ data: [{ id: USER }] });
    await writePresenceLogout(USER, depsFor(client));
    const written = calls[0].values['last_seen_at'];
    assert.notEqual(written, null, 'a null marker is indistinguishable from a redaction');
    assert.equal(typeof written, 'string');
    assert.equal(new Date(written as string).getTime(), 0,
      'the marker must be an instant no positive freshness window can call fresh');
  }

  // The marker has to survive the round trip through Postgres' own rendering of
  // TIMESTAMPTZ, which is `1970-01-01T00:00:00+00:00` - a different string from
  // the one written. Recognition is by parsed time for exactly this reason, so
  // this asserts the two representations agree.
  {
    const postgresRendering = '1970-01-01T00:00:00+00:00';
    assert.equal(new Date(postgresRendering).getTime(),
      new Date(PRESENCE_LOGGED_OUT_AT).getTime(),
      'every rendering of the marker must parse to the same instant');
  }

  // A logout must be idempotent and unconditional: repeated sign-outs must not
  // drift or error, and the value must not depend on a clock reading.
  {
    const { client, calls } = recordingClient({ data: [{ id: USER }] });
    const first = await writePresenceLogout(USER, depsFor(client));
    const second = await writePresenceLogout(USER, depsFor(client));
    assert.equal(first.status, 'written');
    assert.equal(second.status, 'written');
    assert.deepEqual(calls[0].values, calls[1].values,
      'the marker is a constant, so a second logout must write the same value');
  }

  // Identity, in the direction that matters for logout: reading an id from the
  // body would let any signed-in user force any other account OFFLINE. That is a
  // denial-of-presence primitive, the mirror image of the heartbeat's spoofing
  // hole, and the route's `req.user?.id`-only read is what prevents it.
  {
    const { client, calls } = recordingClient({ data: [{ id: USER }] });
    for (const bad of ['', undefined as unknown as string, null as unknown as string]) {
      const outcome = await writePresenceLogout(bad, depsFor(client));
      assert.equal(outcome.status, 'failed',
        `a logout with caller id ${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(calls.length, 0, 'a refused logout must not touch the database at all');
  }

  // A failed logout write must not be silently indistinguishable from a good
  // one - the same invisibility that let the original bug go unreported.
  {
    const { client } = recordingClient({ error: { message: 'permission denied' } });
    const outcome = await writePresenceLogout(USER, depsFor(client));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.status === 'failed' && outcome.message, 'permission denied');

    const noClient = await writePresenceLogout(USER, depsFor(null));
    assert.equal(noClient.status, 'no-client',
      'no writable project must stay distinguishable from a rejected write');
  }

  // Both writers must go through the same single-row, single-column query. If
  // they ever diverged, "mark me online" and "mark me offline" could disagree
  // about which row or which column presence lives in.
  {
    const hb = recordingClient({ data: [{ id: USER }] });
    const lo = recordingClient({ data: [{ id: USER }] });
    await writePresenceHeartbeat(USER, depsFor(hb.client), () => new Date(AT));
    await writePresenceLogout(USER, depsFor(lo.client));
    assert.equal(hb.calls[0].table, lo.calls[0].table);
    assert.deepEqual(hb.calls[0].filters, lo.calls[0].filters,
      'both writers must match the row identically');
    assert.deepEqual(Object.keys(hb.calls[0].values), Object.keys(lo.calls[0].values),
      'both writers must touch exactly one column');
    assert.equal(lo.calls[0].values['last_seen_at'], PRESENCE_LOGGED_OUT_AT);
    assert.notEqual(lo.calls[0].values['last_seen_at'], AT,
      'a logout must not leave the last heartbeat\'s timestamp in place');
  }

  // -------------------------------------------------------------------------
  // 5. The route must not be shadowed by the dynamic domain routes
  // -------------------------------------------------------------------------
  {
    const source = readFileSync(join(__dirname, '..', 'api', 'routes.ts'), 'utf8');
    const presenceAt = source.indexOf("router.post('/presence/heartbeat'");
    assert.ok(presenceAt > -1, 'the heartbeat route must exist');
    const logoutAt = source.indexOf("router.post('/presence/logout'");
    assert.ok(logoutAt > -1, 'the logout route must exist');
    const dynamicPost = source.indexOf("router.post('/:domain'");
    const dynamicGet = source.indexOf("router.get('/:domain'");
    assert.ok(dynamicGet > -1 && dynamicPost > -1, 'the dynamic domain routes must still exist');
    assert.ok(presenceAt < dynamicGet && presenceAt < dynamicPost,
      'the heartbeat must be registered BEFORE the catch-all domain routes, ' +
      'or a future single-segment change would be swallowed by them');
    assert.ok(logoutAt < dynamicGet && logoutAt < dynamicPost,
      'the logout route must be registered BEFORE the catch-all domain routes too');
  }

  console.log('  presence: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
