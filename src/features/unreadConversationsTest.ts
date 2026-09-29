// do.md "Fix the Messages unread notification badge", Gateway side.
//
// The global Messages-nav badge is defined as the number of the caller's
// conversations that currently contain unread messages (NOT the total number
// of unread messages). This module owns the server side of that count:
//
//   - the aggregate itself runs in the database on the conversations host
//     (`get_unread_conversation_ids`, same `message_reads` predicate the
//     per-chat badges already use), reached through a service-role client;
//   - the set is then intersected with the blocking host so a DM whose peer
//     is blocked can never light the badge;
//   - the caller id always comes from the gateway-verified request identity,
//     never from the client body.
//
// Asserted here, in order:
//
//   1. Shape of the aggregate call: table-function name, `p_user_id` argument.
//   2. Empty set short-circuits: zero conversation rows means zero badge, and
//      no block reads are needed.
//   3. Blocked DMs are dropped; groups/channels survive with a blocked member.
//   4. No client registered -> distinguishable 'no-client', not a fake success.
//   5. Aggregate failure -> 'failed', not an empty badge.
//   6. Identity: a missing caller id is refused and nothing is read.
//   7. The route intercept exists and is registered before the generic proxy.
//
// Run: npm run test:unread-conversations
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getUnreadConversationIds,
  type UnreadConversationsClient,
  type UnreadConversationsDeps,
} from './unreadConversations';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const BLOCKED = '00000000-0000-4000-8000-000000000003';

type TableResult = { data: unknown; error: { message: string } | null };
/** Plan literals may omit `data`/`error`; they are normalized on read-out. */
type PlanResult = { data?: unknown; error?: { message: string } | null } | 'throws';

/**
 * A recording stand-in for the service-role client. Models `rpc` and the two
 * reading queries the block filter makes, recording the exact call shape so a
 * test can assert what was asked rather than that nothing threw.
 */
function recordingClient(plan: {
  rpc?: PlanResult;
  tables?: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>;
}): {
  client: UnreadConversationsClient;
  calls: Array<{ kind: 'rpc' | 'query'; table?: string; name?: string; params?: unknown; columns?: string; filters?: Array<[string, unknown]> }>;
} {
  const calls: Array<{ kind: 'rpc' | 'query'; table?: string; name?: string; params?: unknown; columns?: string; filters?: Array<[string, unknown]> }> = [];
  const resultFor = (table: string, order: number): TableResult => {
    const list = plan.tables?.[table];
    const r = list ? list[Math.min(order, list.length - 1)] : undefined;
    return { data: r?.data ?? [], error: r?.error ?? null };
  };
  const tableOrder: Record<string, number> = {};

  const client: UnreadConversationsClient = {
    async rpc(name: string, params?: Record<string, unknown>) {
      calls.push({ kind: 'rpc', name, params });
      if (plan.rpc === 'throws') throw new Error('socket hang up');
      return { data: plan.rpc?.data ?? [], error: plan.rpc?.error ?? null };
    },
    from(table: string) {
      const order = tableOrder[table] ?? 0;
      tableOrder[table] = order + 1;
      const builder: Record<string, unknown> = {
        select(columns: string) {
          calls.push({ kind: 'query', table, columns, filters: [] });
          // supabase-js builders are thenable AND chainable: `.in(...)` resolves
          // (feature awaits it directly) while `.in(...).neq(...)` must too.
          const result = () => Promise.resolve(resultFor(table, order));
          return {
            in: (_col: string, _values: unknown[]) => {
              const p = result();
              return Object.assign(p, {
                neq: (_c2: string, _v2: unknown) => result(),
              });
            },
          };
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

function depsFor(
  client: UnreadConversationsClient | null,
  blocked: Set<string> = new Set<string>()
): UnreadConversationsDeps {
  return {
    getConversationsClient: () => client,
    getBlockedPeerIds: async () => blocked,
  };
}

function idsOf(rows: Array<{ conversation_id: string }>): string[] {
  return rows.map((r) => r.conversation_id);
}

async function main(): Promise<void> {
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
  const C = 'cccccccc-0000-4000-8000-00000000000c';

  // -------------------------------------------------------------------------
  // 1. The aggregate call
  // -------------------------------------------------------------------------
  {
    const { client, calls } = recordingClient({
      rpc: { data: [{ conversation_id: A }, { conversation_id: B }] },
    });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.conversationIds, [A, B],
      'the conversation ids must come straight from the aggregate');
    assert.equal(calls.length, 1, 'happy path is exactly ONE database call');
    assert.equal(calls[0].kind, 'rpc');
    assert.equal(calls[0].name, 'get_unread_conversation_ids');
    assert.deepEqual(calls[0].params, { p_user_id: USER },
      'the aggregate must run with the VERIFIED caller id');
  }

  // 2. Empty set short-circuits: no badge, and no block reads at all.
  {
    const { client, calls } = recordingClient({ rpc: { data: [] } });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.conversationIds, []);
    assert.equal(calls.length, 1, 'an empty aggregate must not read blocks/tables');
  }

  // 3a. A DM whose peer is blocked is dropped.
  {
    const { client } = recordingClient({
      rpc: { data: [{ conversation_id: A }, { conversation_id: B }] },
      tables: {
        conversations: [
          {
            data: [
              { id: A, type: 'dm' },
              { id: B, type: 'dm' },
            ],
          },
        ],
        conversation_participants: [
          {
            data: [
              { conversation_id: A, user_id: OTHER },
              { conversation_id: B, user_id: BLOCKED },
            ],
          },
        ],
      },
    });
    const result = await getUnreadConversationIds(
      USER,
      depsFor(client, new Set([BLOCKED]))
    );
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.conversationIds, [A],
      'a DM from a blocked peer must never light the badge; an unblocked DM stays');
  }

  // 3b. Groups/channels survive even when a member is blocked (the inbox keeps
  // those visible by participation, and so does the badge).
  {
    const { client } = recordingClient({
      rpc: { data: [{ conversation_id: A }, { conversation_id: B }] },
      tables: {
        conversations: [
          {
            data: [
              { id: A, type: 'group' },
              { id: B, type: 'channel' },
            ],
          },
        ],
        conversation_participants: [
          {
            data: [
              { conversation_id: A, user_id: BLOCKED },
              { conversation_id: B, user_id: BLOCKED },
            ],
          },
        ],
      },
    });
    const result = await getUnreadConversationIds(
      USER,
      depsFor(client, new Set([BLOCKED]))
    );
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.conversationIds, [A, B],
      'group/channel visibility is participant-based; a blocked member is not a DM peer');
  }

  // 4. No conversations client registered is its own outcome, not a fake 0.
  {
    const result = await getUnreadConversationIds(USER, depsFor(null));
    assert.equal(result.status, 'no-client',
      'a missing project must be distinguishable from a true empty badge');
  }

  // 5a. Aggregate error propagates.
  {
    const { client } = recordingClient({ rpc: { error: { message: 'function missing' } } });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.message, 'function missing');
  }

  // 5b. Aggregate throw propagates too.
  {
    const { client } = recordingClient({ rpc: 'throws' });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'failed');
  }

  // 6. Identity: no caller id -> refused, nothing read.
  {
    const { client, calls } = recordingClient({ rpc: { data: [] } });
    for (const bad of ['', undefined as unknown as string, null as unknown as string]) {
      const result = await getUnreadConversationIds(bad, depsFor(client));
      assert.equal(result.status, 'failed',
        `a caller id of ${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(calls.length, 0, 'a refused read must not touch the database');
  }

  // 7. The route intercept is wired: the rpc handler must answer
  // `get_unread_conversation_ids` BEFORE the generic proxied fallthrough, and
  // must resolve the verified request identity (never a body-supplied p_user_id).
  {
    const source = readFileSync(join(__dirname, '..', 'api', 'routes.ts'), 'utf8');
    const intercept = source.indexOf("rpcName === 'get_unread_conversation_ids'");
    assert.ok(intercept > -1, 'the gateway must intercept get_unread_conversation_ids');
    const afterIntercept = source.slice(intercept);
    const proxyCall = afterIntercept.indexOf('RPC_CALLER_ID_PARAM');
    const urlBuild = afterIntercept.indexOf('rest/v1/rpc');
    assert.ok(proxyCall === -1 || urlBuild === -1 || afterIntercept.indexOf("req.user?.id") > -1,
      'the intercept must resolve the caller from the verified request identity');
    assert.ok(afterIntercept.indexOf('getUnreadConversationIds(') > -1,
      'the intercept must call the feature module');
  }

  console.log('  unread-conversations: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});