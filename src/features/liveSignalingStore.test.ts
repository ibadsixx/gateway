// Tone Live — UNIT TESTS: durable signaling store semantics.
// Runs with ts-node against the deterministic in-memory fallback (no Supabase
// network access). A fake client also asserts the production code paths use
// DELETE ... RETURNING and a database-generated identity cursor, with no
// Supabase custom RPC. Production schema: migrations 006 and 007.
//
// Covers:
//   - short-lived single-use tickets (replay rejected)
//   - atomic delete-based ticket consumption (no select-then-delete, no RPC)
//   - idempotent message delivery by client-generated id
//   - generated database cursor with no client/sequence function dependency
//   - cursor-based bounded fetches and reconnect/resubscription
//   - broadcast vs directed recipient routing
//   - expiry and cleanup

import {
  createSignalingTicket,
  consumeSignalingTicket,
  storeSignalingMessage,
  fetchSignalingMessages,
  cleanupExpiredSignaling,
  useInMemorySignalingForTests,
  expireSignalingTicketForTests,
  setSignalingClientFactoryForTests,
  resetSignalingClientFactoryForTests,
} from './liveSignalingStore';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

async function main(): Promise<void> {
  console.log('=== Tone Live durable signaling store tests ===\n');
  useInMemorySignalingForTests();

  console.log('--- single-use tickets ---');
  const issued = await createSignalingTicket({
    sessionId: 'session-1', userId: 'user-1', role: 'viewer', ttlSeconds: 60,
  });
  assert(issued.ticket.length >= 32, 'ticket has sufficient entropy');
  assert(!issued.expiresAt.includes('NaN'), 'ticket has a valid expiry');
  const consumed = await consumeSignalingTicket(issued.ticket, 'session-1');
  assert(consumed?.userId === 'user-1', 'ticket resolves to the issuing user');
  assert(consumed?.role === 'viewer', 'ticket carries the Gateway-derived role');
  assert(await consumeSignalingTicket(issued.ticket) === null, 'ticket cannot be consumed twice');
  assert(await consumeSignalingTicket('too-short') === null, 'malformed ticket rejected');

  const wrongSession = await createSignalingTicket({
    sessionId: 'session-2', userId: 'user-2', role: 'host', ttlSeconds: 60,
  });
  assert(await consumeSignalingTicket(wrongSession.ticket, 'session-1') === null,
    'ticket cannot be used for a different session');
  assert((await consumeSignalingTicket(wrongSession.ticket, 'session-2'))?.userId === 'user-2',
    'ticket still valid for its own session after mismatch');

  const expired = await createSignalingTicket({
    sessionId: 'session-1', userId: 'user-3', role: 'guest', ttlSeconds: 60,
  });
  expireSignalingTicketForTests(expired.ticket);
  assert(await consumeSignalingTicket(expired.ticket) === null, 'expired ticket is rejected');

  console.log('\n--- idempotent durable messages ---');
  const first = await storeSignalingMessage({
    id: 'offer-1', sessionId: 'session-1', fromUserId: 'user-1',
    toUserId: 'user-2', type: 'offer', role: 'viewer', sdp: 'v=0',
  });
  const retry = await storeSignalingMessage({
    id: 'offer-1', sessionId: 'session-1', fromUserId: 'user-1',
    toUserId: 'user-2', type: 'offer', role: 'viewer', sdp: 'v=0',
  });
  assert(!first.duplicate, 'first message is stored');
  assert(retry.duplicate, 'retry with same id is a duplicate');
  assert(retry.seq === first.seq, 'duplicate keeps the original cursor');

  console.log('\n--- routing and bounded cursor fetches ---');
  await storeSignalingMessage({
    id: 'broadcast-1', sessionId: 'session-1', fromUserId: 'user-1',
    type: 'join', role: 'viewer', ttlSeconds: 60,
  });
  await storeSignalingMessage({
    id: 'directed-1', sessionId: 'session-1', fromUserId: 'user-1',
    toUserId: 'user-2', type: 'ice-candidate', role: 'viewer',
    candidate: { sdpMid: '0', sdpMLineIndex: 0, candidate: 'candidate:1' }, ttlSeconds: 60,
  });
  await storeSignalingMessage({
    id: 'other-session', sessionId: 'session-2', fromUserId: 'user-1',
    type: 'join', role: 'viewer', ttlSeconds: 60,
  });

  const forUser2 = await fetchSignalingMessages({
    sessionId: 'session-1', recipientUserId: 'user-2', limit: 50,
  });
  assert(forUser2.length === 3, 'recipient sees broadcast + directed + own offer');
  assert(forUser2.every((m) => m.sessionId === 'session-1'), 'results are session scoped');
  assert(forUser2.every((m, i, arr) => i === 0 || arr[i - 1].gatewaySeq! <= m.gatewaySeq!),
    'results are ordered by cursor');

  const forUser3 = await fetchSignalingMessages({
    sessionId: 'session-1', recipientUserId: 'user-3', limit: 50,
  });
  assert(forUser3.length === 1 && forUser3[0].id === 'broadcast-1',
    'directed messages are not delivered to other users');

  const cursor = forUser2[1].gatewaySeq!;
  const resumed = await fetchSignalingMessages({
    sessionId: 'session-1', recipientUserId: 'user-2', afterSeq: cursor, limit: 50,
  });
  assert(resumed.every((m) => m.gatewaySeq! > cursor), 'reconnect resumes after the cursor');

  const bounded = await fetchSignalingMessages({
    sessionId: 'session-1', recipientUserId: 'user-2', limit: 1,
  });
  assert(bounded.length === 1, 'fetch limit is enforced');

  console.log('\n--- simulated cross-instance delivery ---');
  // Two independent readers with separate local cursors, both polling the same
  // durable store. This models two Vercel Function instances that share no
  // memory; in production the shared store is Supabase (migration 005).
  let cursorA = 0;
  let cursorB = 0;
  const drain = async (recipient: string, cursor: number) => {
    const page = await fetchSignalingMessages({
      sessionId: 'session-1', recipientUserId: recipient, afterSeq: cursor, limit: 50,
    });
    return { cursor: page.length ? page[page.length - 1].gatewaySeq! : cursor, ids: page.map((m) => m.id) };
  };
  const initialA = await drain('user-2', cursorA);
  const initialB = await drain('user-2', cursorB);
  cursorA = initialA.cursor;
  cursorB = initialB.cursor;
  assert(initialA.ids.join() === initialB.ids.join(), 'both instances see the same durable backlog');

  await storeSignalingMessage({
    id: 'cross-instance-1', sessionId: 'session-1', fromUserId: 'user-1',
    type: 'participant-state', role: 'host', state: { isMuted: true }, ttlSeconds: 60,
  });
  const nextA = await drain('user-2', cursorA);
  const nextB = await drain('user-2', cursorB);
  assert(nextA.ids.includes('cross-instance-1'), 'instance A receives the new message');
  assert(nextB.ids.includes('cross-instance-1'), 'instance B receives the new message');
  cursorA = nextA.cursor;
  cursorB = nextB.cursor;
  const emptyA = await drain('user-2', cursorA);
  assert(emptyA.ids.length === 0, 'already-delivered messages are not replayed');

  console.log('\n--- expiry and cleanup ---');
  await storeSignalingMessage({
    id: 'short-lived', sessionId: 'session-1', fromUserId: 'user-1',
    type: 'leave', role: 'viewer', ttlSeconds: 30,
  });
  await cleanupExpiredSignaling();
  const afterCleanup = await fetchSignalingMessages({
    sessionId: 'session-1', recipientUserId: 'user-2', limit: 50,
  });
  assert(afterCleanup.some((m) => m.id === 'broadcast-1'), 'unexpired rows survive cleanup');

  console.log('\n--- production client path (fake Supabase client) ---');
  const fakeResults: Array<{ data?: unknown; error?: { message: string } | null }> = [
    { error: null },                                                    // ticket insert
    { data: { session_id: 'session-9', user_id: 'user-9', role: 'viewer' }, error: null }, // delete returning
    { data: { seq: 77 }, error: null },                                  // message identity cursor
  ];
  const fakeCalls: string[] = [];
  let upsertedRow: Record<string, unknown> | null = null;

  class FakeQuery {
    constructor(
      private readonly table: string,
      private readonly result: { data?: unknown; error?: { message: string } | null },
    ) {
      fakeCalls.push(`from:${table}`);
    }

    delete(): this { fakeCalls.push('delete'); return this; }
    update(): this { fakeCalls.push('update'); return this; }
    insert(row: Record<string, unknown>): this {
      fakeCalls.push('insert');
      if (this.table === 'live_signaling_tickets') upsertedRow = row;
      return this;
    }
    upsert(row: Record<string, unknown>): this {
      fakeCalls.push('upsert');
      upsertedRow = row;
      return this;
    }
    eq(column: string, _value: unknown): this { fakeCalls.push(`eq:${column}`); return this; }
    is(column: string, _value: unknown): this { fakeCalls.push(`is:${column}`); return this; }
    gt(column: string, _value: unknown): this { fakeCalls.push(`gt:${column}`); return this; }
    lt(column: string, _value: unknown): this { fakeCalls.push(`lt:${column}`); return this; }
    select(columns = '*'): this { fakeCalls.push(`select:${columns}`); return this; }
    order(): this { fakeCalls.push('order'); return this; }
    limit(): this { fakeCalls.push('limit'); return this; }
    maybeSingle(): Promise<{ data?: unknown; error?: { message: string } | null }> {
      fakeCalls.push('maybeSingle');
      return Promise.resolve(this.result);
    }
    then(onFulfilled?: unknown, onRejected?: unknown): Promise<unknown> {
      return Promise.resolve(this.result).then(
        onFulfilled as (value: unknown) => unknown,
        onRejected as (reason: unknown) => unknown,
      );
    }
  }

  const fakeClient = {
    from(table: string): FakeQuery {
      const result = fakeResults.shift() ?? { data: null, error: null };
      return new FakeQuery(table, result);
    },
    rpc(): never {
      fakeCalls.push('rpc');
      throw new Error('Custom Supabase RPC must not be used');
    },
  };

  setSignalingClientFactoryForTests(async () => fakeClient);
  const fakeTicket = await createSignalingTicket({
    sessionId: 'session-9', userId: 'user-9', role: 'viewer', ttlSeconds: 60,
  });
  const fakeConsumed = await consumeSignalingTicket(fakeTicket.ticket, 'session-9');
  const fakeStored = await storeSignalingMessage({
    id: 'generated-cursor-1', sessionId: 'session-9', fromUserId: 'user-9',
    type: 'offer', role: 'viewer', sdp: 'v=0',
  });

  assert(fakeConsumed?.userId === 'user-9', 'delete-returning resolves the ticket user');
  assert(fakeCalls.includes('delete'), 'ticket consumption issues DELETE');
  assert(fakeCalls.includes('eq:token_hash'), 'ticket hash is matched in the DELETE predicate');
  assert(fakeCalls.includes('is:consumed_at'), 'unconsumed state is required in the DELETE predicate');
  assert(fakeCalls.includes('gt:expires_at'), 'unexpired state is required in the DELETE predicate');
  assert(fakeCalls.includes('select:session_id,user_id,role'), 'DELETE returns the consumed row');
  assert(!fakeCalls.includes('update'), 'ticket consumption is not SELECT-then-UPDATE');
  assert(!fakeCalls.includes('rpc'), 'no Supabase custom RPC/function is called');
  assert(fakeStored.seq === 77 && !fakeStored.duplicate, 'database-generated cursor is returned');
  assert(upsertedRow !== null && !('seq' in upsertedRow), 'message insert omits client-generated seq');

  resetSignalingClientFactoryForTests();
  useInMemorySignalingForTests();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Test harness error:', error);
  process.exit(1);
});
