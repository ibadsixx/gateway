// do.md "Fix the Messages unread notification badge" + mobile-badge round,
// Gateway side.
//
// The global Messages-nav badge is the number of the caller's conversations
// that contain unread messages. This module owns the server side of that count:
// it reads the deployed `get_conversations_with_info`, which already computes a
// per-conversation `unread_count` with exactly the predicate the badge needs,
// keeps the conversations whose count is above zero, and then drops DMs whose
// peer is blocked (the block list lives on another project host, so that rule
// cannot live in the same SQL).
//
// Asserted here, in order:
//
//   1. One call, the right function, and the VERIFIED caller as the argument.
//   2. The badge counts conversations, not messages: unread_count 0 drops out,
//      a large unread_count still contributes exactly one conversation, and a
//      bigint returned as a string is coerced rather than silently dropped.
//   3. Blocked DMs are dropped; groups/channels survive a blocked member, and
//      the filter costs NO extra query (other_user_id is already in the row).
//   4. A failing block read fails OPEN (a badge the user can see is not worse
//      than an empty one that lies).
//   5. No client registered -> distinguishable 'no-client', not a fake success.
//   6. A failed read -> 'failed', not an empty badge that reads as "all read".
//   7. Identity: a missing caller id is refused and nothing is read.
//   8. The route intercept exists, is registered before the generic proxy, and
//      resolves the caller from the verified request identity.
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
const BLOCKED = '00000000-0000-4000-8000-000000000003';
const PEER = '00000000-0000-4000-8000-000000000004';

type PlanResult = { data?: unknown; error?: { message: string } | null } | 'throws';

/**
 * A recording stand-in for the service-role client. It models ONLY the rpc
 * call, and throws on any table read: the whole point of the current design is
 * that one conversation read is enough, so a stray second query fails loudly
 * here instead of quietly costing a request in production.
 */
function recordingClient(plan: { rpc?: PlanResult }) {
  const calls: Array<{ name: string; params: unknown }> = [];
  const client: UnreadConversationsClient = {
    async rpc(name: string, params?: Record<string, unknown>) {
      calls.push({ name, params });
      if (plan.rpc === 'throws') throw new Error('socket hang up');
      return { data: plan.rpc?.data ?? [], error: plan.rpc?.error ?? null };
    },
    from(table: string) {
      throw new Error(`unexpected table read: ${table} (the badge must need one rpc only)`);
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

const conv = (
  conversation_id: string,
  unread_count: number | string,
  type = 'dm',
  other_user_id: string | null = PEER
) => ({ conversation_id, unread_count, type, other_user_id });

async function main(): Promise<void> {
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
  const C = 'cccccccc-0000-4000-8000-00000000000c';

  // -------------------------------------------------------------------------
  // 1. One call, the deployed function, the verified caller.
  // -------------------------------------------------------------------------
  {
    const { client, calls } = recordingClient({
      rpc: { data: [conv(A, 1), conv(B, 4)] },
    });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.conversationIds, [A, B]);
    assert.equal(calls.length, 1, 'the happy path is exactly ONE database call');
    assert.equal(calls[0].name, 'get_conversations_with_info');
    assert.deepEqual(
      calls[0].params,
      { p_user_id: USER },
      'the read must run as the VERIFIED caller, never a body-supplied id'
    );
  }

  // -------------------------------------------------------------------------
  // 2. The badge counts CONVERSATIONS, not messages.
  // -------------------------------------------------------------------------
  {
    const { client, calls } = recordingClient({
      rpc: {
        data: [
          conv(A, 7), // 7 unread messages, but ONE conversation
          conv(B, 0), // fully read -> must not appear
          conv(C, '3'), // bigint arriving as a string still counts
        ],
      },
    });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.status === 'ok' && result.conversationIds,
      [A, C],
      '5 unread messages in one conversation is 1, a read conversation is 0, ' +
        'and a stringified bigint must not be lost'
    );
    assert.equal(calls.length, 1);
  }

  {
    // Every conversation read -> badge 0, and no block lookup is even needed.
    const { client, calls } = recordingClient({ rpc: { data: [conv(A, 0), conv(B, 0)] } });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.conversationIds, []);
    assert.equal(calls.length, 1, 'an all-read inbox must not trigger a block read');
  }

  // -------------------------------------------------------------------------
  // 3. Block filtering, at no extra query cost.
  // -------------------------------------------------------------------------
  {
    const { client, calls } = recordingClient({
      rpc: {
        data: [
          conv(A, 1, 'dm', PEER), // peer is fine
          conv(B, 1, 'dm', BLOCKED), // peer is blocked
        ],
      },
    });
    const result = await getUnreadConversationIds(USER, depsFor(client, new Set([BLOCKED])));
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.status === 'ok' && result.conversationIds,
      [A],
      "a blocked peer's DM must never light the badge; an unblocked DM stays"
    );
    assert.equal(
      calls.length,
      1,
      'other_user_id is already on the row: the filter must not add a second read'
    );
  }

  {
    // Groups/channels keep participant-based visibility, matching the inbox.
    const { client } = recordingClient({
      rpc: {
        data: [
          conv(A, 1, 'group', BLOCKED),
          conv(B, 1, 'channel', BLOCKED),
        ],
      },
    });
    const result = await getUnreadConversationIds(USER, depsFor(client, new Set([BLOCKED])));
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.status === 'ok' && result.conversationIds,
      [A, B],
      'a blocked member is not a DM peer, so groups/channels stay'
    );
  }

  {
    // A DM row with no resolvable peer cannot be attributed to a block.
    const { client } = recordingClient({ rpc: { data: [conv(A, 1, 'dm', null)] } });
    const result = await getUnreadConversationIds(USER, depsFor(client, new Set([BLOCKED])));
    assert.deepEqual(result.status === 'ok' && result.conversationIds, [A]);
  }

  // -------------------------------------------------------------------------
  // 4. A failing block read fails OPEN.
  // -------------------------------------------------------------------------
  {
    const { client } = recordingClient({ rpc: { data: [conv(A, 1), conv(B, 1)] } });
    const result = await getUnreadConversationIds(USER, {
      getConversationsClient: () => client,
      getBlockedPeerIds: async () => {
        throw new Error('blocking host down');
      },
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.status === 'ok' && result.conversationIds,
      [A, B],
      'a block-host outage must not blank a badge the user is already looking at'
    );
  }

  // -------------------------------------------------------------------------
  // 5. No client registered is its own outcome, not a fake 0.
  // -------------------------------------------------------------------------
  {
    const result = await getUnreadConversationIds(USER, depsFor(null));
    assert.equal(
      result.status,
      'no-client',
      'a missing project must be distinguishable from a true empty badge'
    );
  }

  // -------------------------------------------------------------------------
  // 6. A failed read must not read as "all conversations are read".
  // -------------------------------------------------------------------------
  {
    const { client } = recordingClient({ rpc: { error: { message: 'boom' } } });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.message, 'boom');
  }

  {
    const { client } = recordingClient({ rpc: 'throws' });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'failed');
  }

  {
    // A non-array payload is not silently treated as "nothing is unread".
    const { client } = recordingClient({ rpc: { data: { unexpected: true } } });
    const result = await getUnreadConversationIds(USER, depsFor(client));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.status === 'ok' && result.conversationIds, []);
  }

  // -------------------------------------------------------------------------
  // 7. Identity: no caller id -> refused, nothing read.
  // -------------------------------------------------------------------------
  {
    const { client, calls } = recordingClient({ rpc: { data: [] } });
    for (const bad of ['', undefined as unknown as string, null as unknown as string]) {
      const result = await getUnreadConversationIds(bad, depsFor(client));
      assert.equal(result.status, 'failed', `a caller id of ${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(calls.length, 0, 'a refused read must not touch the database');
  }

  // -------------------------------------------------------------------------
  // 8. The route intercept is wired and identity-bound.
  // -------------------------------------------------------------------------
  {
    const source = readFileSync(join(__dirname, '..', 'api', 'routes.ts'), 'utf8');
    const intercept = source.indexOf("rpcName === 'get_unread_conversation_ids'");
    assert.ok(intercept > -1, 'the gateway must intercept get_unread_conversation_ids');
    const after = source.slice(intercept);
    assert.ok(
      after.indexOf('getUnreadConversationIds(') > -1,
      'the intercept must call the feature module'
    );
    assert.ok(
      after.indexOf('getUnreadConversationIds(req.user?.id)') > -1,
      'the intercept must pass the verified request identity, never a body id'
    );
    const proxyUrl = after.indexOf('rest/v1/rpc');
    const handler = after.indexOf('rpcRouter.post');
    if (proxyUrl > -1) {
      assert.ok(proxyUrl > handler, 'the intercept must precede the generic proxy fallthrough');
    }
  }

  console.log('  unread-conversations: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
