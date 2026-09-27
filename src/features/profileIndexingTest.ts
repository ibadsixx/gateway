// do.md "Fix Privacy Checkup - Search Engine Profile Indexing", Gateway side.
//
// Two things are under test and they are not equally important:
//
//   1. The consent test. `search_engine_indexing` is opt-IN everywhere it is
//      expressed, so the only value that may unlock indexing is the exact string
//      the Privacy Checkup switch writes. Everything else - absent, 'false',
//      'TRUE', a boolean, a number, a row that failed to load - must resolve to
//      "not indexable". This is the assertion that would catch a future
//      "let me be lenient about the value" change, which is the kind of change
//      that looks like a robustness fix and is actually a privacy regression.
//
//   2. The route. It is unauthenticated (a crawler has no session), it answers
//      for a single username, and it must never leak another privacy setting on
//      the way past. The last point is asserted on the actual SELECT rather than
//      trusted: `privacy_settings` holds a user's whole privacy configuration, so
//      an endpoint that selected `*` here would be a new way to read it.
//
// Run: npm run test:profile-indexing
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { router } from '../api/routes';
import { projectManager } from '../project-manager';
import { isIndexableProfileRow } from './sitemap';
import {
  PROFILE_INDEXING_OPT_IN,
  PROFILE_INDEXING_SETTING,
  isSearchEngineIndexingOptIn,
  isValidProfileUsername,
  readProfileIndexingOptIn,
  type ProfileIndexingDeps,
} from './profileIndexing';

type Row = Record<string, unknown>;
type Filter = [string, unknown];
interface RecordedQuery {
  table: string;
  select: unknown;
  filters: Filter[];
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. The consent test
  // -------------------------------------------------------------------------
  assert.equal(PROFILE_INDEXING_SETTING, 'search_engine_indexing',
    'the setting key must stay equal to the literal PrivacyCheckup.tsx writes');
  assert.equal(PROFILE_INDEXING_OPT_IN, 'true',
    'the only value that counts as consent is the exact string the switch writes');

  assert.equal(isSearchEngineIndexingOptIn('true'), true, "'true' is consent");

  // Everything that is not consent. Each is a real possibility: drift in the
  // column, a partial write, a different client, a JSON boolean arriving where a
  // string was expected.
  for (const notConsent of [
    'false', 'TRUE', 'True', ' true', 'true ', 'yes', '1', 'on', '',
    null, undefined, true, false, 1, 0, {}, [], ['true'],
  ]) {
    assert.equal(isSearchEngineIndexingOptIn(notConsent), false,
      `${JSON.stringify(notConsent)} is NOT consent and must not index a profile`);
  }

  // -------------------------------------------------------------------------
  // 2. Username validation - the app's own convention
  // -------------------------------------------------------------------------
  for (const good of ['ada', 'ada_2', 'A', 'a'.repeat(64), '_x']) {
    assert.equal(isValidProfileUsername(good), true, `${good} is a valid username`);
  }
  for (const bad of [
    '', 'a'.repeat(65), 'ada.lovelace', 'ada lovelace', 'ada/../etc', 'ada%20',
    "ada'", 'ada"', 'ada\tada', 'ada ', null, undefined, 42, {},
  ]) {
    assert.equal(isValidProfileUsername(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }

  // -------------------------------------------------------------------------
  // 3. The reader, with injected deps
  // -------------------------------------------------------------------------
  const depsFor = (rows: Array<{ user_id: string; setting_value: unknown }>): ProfileIndexingDeps => ({
    async findProfileIdsByUsername() {
      return ['user-1'];
    },
    async readIndexingSetting() {
      const row = rows.find((r) => r.user_id === 'user-1');
      return row ? row.setting_value : undefined;
    },
  });

  assert.deepEqual(
    await readProfileIndexingOptIn('ada', depsFor([{ user_id: 'user-1', setting_value: 'true' }])),
    { found: true, optIn: true },
    'an explicit opt-in indexes the profile'
  );

  // The important one: a real profile that never answered the question.
  assert.deepEqual(
    await readProfileIndexingOptIn('ada', depsFor([])),
    { found: true, optIn: false },
    'a profile with NO setting row exists but is not indexable - absent is not consent'
  );
  assert.deepEqual(
    await readProfileIndexingOptIn('ada', depsFor([{ user_id: 'user-1', setting_value: 'false' }])),
    { found: true, optIn: false },
    'an explicit opt-out does not index'
  );
  assert.deepEqual(
    await readProfileIndexingOptIn('ada', depsFor([{ user_id: 'user-1', setting_value: 'TRUE' }])),
    { found: true, optIn: false },
    'a wrong-case value is drift, not consent'
  );

  // A username nobody has. The settings read must not even be attempted.
  const noProfile: ProfileIndexingDeps = {
    async findProfileIdsByUsername() {
      return [];
    },
    async readIndexingSetting() {
      throw new Error('must not be asked about a profile that does not exist');
    },
  };
  assert.deepEqual(
    await readProfileIndexingOptIn('ghost', noProfile),
    { found: false, optIn: false },
    'an unknown username is not found, and is still not indexable'
  );

  // Infrastructure failure. The profile is real, so `found` stays true, but the
  // answer is unreadable and the safe reading of "I could not determine this" is
  // "do not index".
  const exploding: ProfileIndexingDeps = {
    async findProfileIdsByUsername() {
      return ['user-1'];
    },
    async readIndexingSetting() {
      throw new Error('supabase timeout');
    },
  };
  assert.deepEqual(
    await readProfileIndexingOptIn('ada', exploding),
    { found: true, optIn: false },
    'a failed settings read fails CLOSED, not open'
  );

  assert.deepEqual(
    await readProfileIndexingOptIn('not a username', depsFor([{ user_id: 'user-1', setting_value: 'true' }])),
    { found: false, optIn: false },
    'a malformed username never reaches the database'
  );

  // -------------------------------------------------------------------------
  // 4. The sitemap agrees with the profile page, on every value
  // -------------------------------------------------------------------------
  // do.md requires the profile page AND the dynamic sitemap to honour this one
  // setting. They are two code paths reading one column, so the risk is not that
  // one is wrong but that they are wrong in DIFFERENT directions - the page
  // saying "index me" for a row the sitemap has stopped listing, or the sitemap
  // listing a row the page has marked noindex. Google is then told to crawl a URL
  // the sitemap just withdrew.
  //
  // This drives the sitemap's own predicate with the same values the route test
  // uses, so any future divergence in the shared test fails here.
  {
    const sitemapSaysIndexable = (value: unknown) =>
      isIndexableProfileRow({
        id: 'user-1',
        username: 'ada',
        search_engine_indexing: value,
      } as never);
    // The route's view of the same value, straight from the shared predicate.
    const pageSaysIndexable = (value: unknown) => isSearchEngineIndexingOptIn(value);

    for (const value of ['true', 'false', 'TRUE', 'True', ' true', 'true ', 'yes', '1', '',
                         null, undefined, true, false, 1, 0]) {
      assert.equal(
        sitemapSaysIndexable(value),
        pageSaysIndexable(value),
        `the sitemap and the profile page must agree on ${JSON.stringify(value)}`
      );
    }
    assert.equal(sitemapSaysIndexable('true'), true, 'and the one consenting value indexes both');
    assert.equal(sitemapSaysIndexable('false'), false, 'and an opt-out withdraws from both');
    assert.equal(sitemapSaysIndexable(undefined), false, 'and an absent row withdraws from both');

    // A username the app could never link to is not listed, whatever the answer.
    for (const username of ['ada.lovelace', 'ada lovelace', '', 'a'.repeat(65)]) {
      assert.equal(
        isIndexableProfileRow({ id: 'user-1', username, search_engine_indexing: 'true' } as never),
        false,
        `${JSON.stringify(username)} is not a listable profile path`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. The route, over a real listener
  // -------------------------------------------------------------------------
  const queries: RecordedQuery[] = [];
  let tables: Record<string, Row[]> = {};
  let failing = new Set<string>();

  // Each chain method is explicit rather than built by one shared closure. A
  // closure over the method name captures 'from' once and never records the
  // method a later call actually used, which turns every filter into a no-op and
  // makes the whole route section pass for the wrong reason.
  const record = (table: string) => {
    const entry: RecordedQuery = { table, select: undefined, filters: [] };
    const self: any = {
      select: (s: unknown) => {
        entry.select = s;
        return self;
      },
      eq: (column: string, v: unknown) => {
        entry.filters.push([`eq:${column}`, v]);
        return self;
      },
      in: (column: string, v: unknown) => {
        entry.filters.push([`in:${column}`, v]);
        return self;
      },
      limit: () => self,
    };
    // Thenable, so `await` resolves the chain the way supabase-js does.
    self.then = (resolve: (v: unknown) => void) => {
      if (failing.has(table)) return resolve({ data: null, error: { message: 'boom' } });
      let rows = tables[table] ?? [];
      for (const [f, v] of entry.filters) {
        const [method, column] = f.split(':');
        if (method === 'eq') rows = rows.filter((r) => String(r[column]) === String(v));
        if (method === 'in') rows = rows.filter((r) => (v as unknown[]).map(String).includes(String(r[column])));
      }
      resolve({ data: rows, error: null });
    };
    queries.push(entry);
    return self;
  };

  const original = projectManager.getReadableProjects.bind(projectManager);
  (projectManager as any).getReadableProjects = (domain: string) =>
    ['profiles', 'users', 'privacy_settings'].includes(domain)
      ? [{ client: { from: (t: string) => record(t) } }]
      : [];

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    const body = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* not json */
    }
    return { status: res.status, headers: res.headers, json, body };
  };

  try {
    // --- the ON state, unauthenticated -------------------------------
    tables = {
      profiles: [{ id: 'user-1', username: 'ada' }],
      privacy_settings: [
        { user_id: 'user-1', setting_name: 'search_engine_indexing', setting_value: 'true' },
      ],
    };
    queries.length = 0;
    const on = await get('/api/public/profile-indexing?username=ada');
    assert.equal(on.status, 200, `ON answers 200 logged out (got ${on.status}: ${on.body})`);
    assert.deepEqual(on.json, { search_engine_indexing: true }, 'ON reports the opt-in');

    // No auth challenge: a crawler has no session, and gating this on one would
    // mean the directive can only be produced for a signed-in viewer.
    assert.equal(on.headers.get('www-authenticate'), null, 'and it is not an auth challenge');

    // --- it selects the minimum, and never another privacy setting ----
    const settingsQuery = queries.find((q) => q.table === 'privacy_settings');
    assert.ok(settingsQuery, 'the setting was read');
    const selectedCols = String(settingsQuery.select).split(',').map((c) => c.trim());
    assert.deepEqual(selectedCols, ['setting_value'],
      `only the one column is selected, never the rest of the privacy config (got ${selectedCols})`);
    assert.deepEqual(
      settingsQuery.filters.find(([f]) => f === 'eq:setting_name'),
      ['eq:setting_name', 'search_engine_indexing'],
      'and it is constrained to this setting, so no other preference is readable through here'
    );
    const profileQuery = queries.find((q) => q.table === 'profiles');
    assert.ok(profileQuery, 'the profile was resolved from the username');
    assert.deepEqual(String(profileQuery.select).split(',').map((c) => c.trim()), ['id'],
      'the profile read asks for the id only');

    // The filter that finds the profile must actually be applied - if the stub's
    // chain were inert, every assertion above would pass without the route
    // filtering anything at all.
    assert.deepEqual(
      profileQuery.filters.find(([f]) => f === 'eq:username'),
      ['eq:username', 'ada'],
      'the profile is looked up by the requested username, not returned wholesale'
    );

    // --- the OFF state, and every unresolved state, is not indexable -
    for (const [label, value] of [
      ['explicit false', 'false'],
      ['absent row', undefined],
      ['wrong case', 'TRUE'],
      ['garbage', 'maybe'],
    ] as const) {
      tables = {
        profiles: [{ id: 'user-1', username: 'ada' }],
        privacy_settings:
          value === undefined
            ? []
            : [{ user_id: 'user-1', setting_name: 'search_engine_indexing', setting_value: value }],
      };
      const off = await get('/api/public/profile-indexing?username=ada');
      assert.equal(off.status, 200, `${label}: the profile still exists, so 200 (got ${off.status})`);
      assert.deepEqual(off.json, { search_engine_indexing: false },
        `${label}: not indexable - this is the case that publishes someone who said no`);
    }

    // --- unknown username is 404, not a false "opted out" ------------
    tables = { profiles: [] };
    const ghost = await get('/api/public/profile-indexing?username=ghost');
    assert.equal(ghost.status, 404, `an unknown username is 404 (got ${ghost.status})`);

    // --- malformed usernames are 400 and never reach the database -----
    for (const bad of ['ada.lovelace', 'ada lovelace', "ada'", 'a'.repeat(65), 'ada%20']) {
      queries.length = 0;
      const res = await get(`/api/public/profile-indexing?username=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `${JSON.stringify(bad)} is a 400 (got ${res.status})`);
      assert.equal(queries.length, 0, `${JSON.stringify(bad)} issued no database query`);
    }
    const missing = await get('/api/public/profile-indexing');
    assert.equal(missing.status, 400, `a missing username is a 400 (got ${missing.status})`);
    const repeated = await get('/api/public/profile-indexing?username=ada&username=bob');
    assert.equal(repeated.status, 400, 'a repeated username param is a 400, not an array being coerced');

    // --- an unreadable table fails closed, and says nothing internals -
    tables = { profiles: [{ id: 'user-1', username: 'ada' }] };
    failing = new Set(['privacy_settings']);
    const broken = await get('/api/public/profile-indexing?username=ada');
    assert.equal(broken.status, 200, 'a failed settings read still answers, so the client can render');
    assert.deepEqual(broken.json, { search_engine_indexing: false },
      'and it fails CLOSED rather than reporting a default of true');
    assert.equal(/boom|supabase|error/i.test(broken.body), false,
      'and no internal error text is exposed in the response');
    failing = new Set();

    // --- it is not cached ---------------------------------------------
    // Every other public read in the Gateway is shared for 5 minutes. This one is
    // the input to a privacy directive, so a cached `true` would keep telling
    // crawlers to index a profile whose owner has since opted out.
    assert.equal(on.headers.get('cache-control'), 'no-store',
      `the directive source must not be cached (got ${on.headers.get('cache-control')})`);
    assert.equal((on.headers.get('cache-control') || '').includes('s-maxage'), false,
      'and specifically carries no shared-cache TTL');

    // --- it is not the domain catch-all -------------------------------
    // A two-segment path, so `/:domain` cannot swallow it. Asserted so a future
    // route move cannot quietly turn it into a domain read.
    assert.notEqual(on.body, 'Not found', 'the route is reachable, not routed as a domain');
  } finally {
    (projectManager as any).getReadableProjects = original;
    server.close();
  }

  console.log('profileIndexingTest: all assertions passed ✓');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
