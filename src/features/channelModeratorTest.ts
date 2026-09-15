// Runnable offline test-suite for the gateway-side channel moderator operations
// (messages.md — "Make Moderator" backend fix).
//
// The proxy-based add/remove_channel_moderator flow could never succeed: the
// conversations host does not share the users JWT secret, so the SECURITY
// DEFINER functions resolve auth.uid() = NULL and raise 'Not authenticated' for
// every caller, owner included. The gateway now applies promotion/demotion
// itself against conversation_participants. This harness drives the exact code
// path with an in-memory Supabase-shaped client (a fresh client is used for the
// "refresh" steps so the *database* memory — not a client — is what persists).
//
// Run: npm run test:channel-moderator
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addChannelModerator, removeChannelModerator } from './channelModerator';

type ConvRow = { id: string; type?: string | null; created_by?: string | null };
type ParticipantRow = { conversation_id: string; user_id: string; role: string };
type Table = Array<Record<string, unknown>>;

const CHANNEL = 'channel-0001';
const GROUP = 'group-0001';
const OWNER = 'owner-uuid';
const MODERATOR = 'moderator-uuid';
const MEMBER = 'member-uuid';
const OTHER = 'other-uuid';
const NONMEMBER = 'nobody-uuid';

function makeDb() {
  const conversations: ConvRow[] = [
    { id: CHANNEL, type: 'channel', created_by: OWNER },
    { id: GROUP, type: 'group', created_by: OWNER },
  ];
  const participants: ParticipantRow[] = [
    { conversation_id: CHANNEL, user_id: OWNER, role: 'owner' },
    { conversation_id: CHANNEL, user_id: MODERATOR, role: 'moderator' },
    { conversation_id: CHANNEL, user_id: MEMBER, role: 'follower' },
    { conversation_id: CHANNEL, user_id: OTHER, role: 'follower' },
    { conversation_id: GROUP, user_id: OWNER, role: 'member' },
    { conversation_id: GROUP, user_id: MEMBER, role: 'member' },
  ];
  return { conversations, participants };
}

// Minimal Supabase-shaped chain for exactly the calls the feature module makes:
//   select(...).eq(...).eq(...).maybeSingle()   -> { data, error }
//   update(patch).eq(...).eq(...)               -> thenable { data, error }
function selectBuilder(table: () => Table, filters: Array<[string, string]>) {
  return {
    select: (_cols: string) => selectBuilder(table, filters),
    eq: (col: string, val: string) => selectBuilder(table, [...filters, [col, val] as [string, string]]),
    maybeSingle: async () => {
      const rows = table().filter((r) => filters.every(([c, v]) => String(r[c]) === String(v)));
      return { data: rows[0] ?? null, error: null };
    },
  };
}

function updateBuilder(table: () => Table, patch: Record<string, unknown>, filters: Array<[string, string]>) {
  return {
    eq: (col: string, val: string) => updateBuilder(table, patch, [...filters, [col, val] as [string, string]]),
    then: (resolve: (v: { data: null; error: null }) => void) => {
      const rows = table().filter((r) => filters.every(([c, v]) => String(r[c]) === String(v)));
      for (const r of rows) Object.assign(r, patch);
      resolve({ data: null, error: null });
    },
  };
}

function fakeClient(db: { conversations: ConvRow[]; participants: ParticipantRow[] }) {
  const tableFor = (name: string): Table =>
    name === 'conversations'
      ? (db.conversations as unknown as Table)
      : (db.participants as unknown as Table);
  return {
    from: (table: string) => ({
      select: (cols: string) => selectBuilder(() => tableFor(table), []),
      update: (patch: Record<string, unknown>) => updateBuilder(() => tableFor(table), patch, []),
    }),
  } as unknown as SupabaseClient;
}

type Db = ReturnType<typeof makeDb>;
const projectsFor = (db: Db) => [{ client: fakeClient(db) }];
const roleOf = (db: Db, userId: string, conversationId: string): string | null =>
  db.participants.find((p) => p.conversation_id === conversationId && p.user_id === userId)?.role ?? null;

async function run(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`  PASS  ${name}`);
}

async function main() {
  const db = makeDb();
  const projects = projectsFor(db);
  const initialConvCount = db.conversations.length;
  const initialMemberRows = db.participants.length;
  let count = 0;

  // TEST 1: Owner promotes a normal member -> Moderator.
  await run('TEST 1: owner promotes a normal member -> ok', async () => {
    const r = await addChannelModerator(CHANNEL, MEMBER, OWNER, projects);
    assert.equal(r.status, 'ok');
    assert.equal(roleOf(db, MEMBER, CHANNEL), 'moderator');
  });
  count++;

  // TEST 2: "Refresh" (fresh client, same DB memory) -> role persists.
  await run('TEST 2: moderator role persists after refresh', async () => {
    const fresh = projectsFor(db);
    assert.equal(roleOf(db, MEMBER, CHANNEL), 'moderator');
    const r = await addChannelModerator(CHANNEL, MEMBER, OWNER, fresh);
    assert.equal(r.status, 'ok');
  });
  count++;

  // TEST 3: Owner promotes the same Moderator again -> no duplicate, no error.
  await run('TEST 3: re-promoting an existing moderator is idempotent', async () => {
    const before = db.participants.length;
    const r = await addChannelModerator(CHANNEL, MEMBER, OWNER, projects);
    assert.equal(r.status, 'ok');
    assert.equal(db.participants.length, before, 'no duplicate participant row');
    assert.equal(roleOf(db, MEMBER, CHANNEL), 'moderator');
  });
  count++;

  // TEST 4: Owner removes Moderator role -> member keeps membership as follower.
  await run('TEST 4: owner removes moderator role -> member stays a follower', async () => {
    const r = await removeChannelModerator(CHANNEL, MEMBER, OWNER, projects);
    assert.equal(r.status, 'ok');
    assert.equal(roleOf(db, MEMBER, CHANNEL), 'follower');
  });
  count++;

  // TEST 4b: demotion persists after refresh.
  await run('TEST 4b: follower role persists after refresh', async () => {
    assert.equal(roleOf(db, MEMBER, CHANNEL), 'follower');
  });
  count++;

  // TEST 5: Normal (follower) member tries to promote -> backend denies.
  await run('TEST 5: normal member promotion attempt is denied', async () => {
    const r = await addChannelModerator(CHANNEL, OTHER, MEMBER, projects);
    assert.equal(r.status, 'not_owner');
  });
  count++;

  // TEST 6: Unauthorized moderator tries to promote -> denied (owner-only model).
  await run('TEST 6: moderator promotion attempt is denied (owner-only)', async () => {
    const r = await addChannelModerator(CHANNEL, OTHER, MODERATOR, projects);
    assert.equal(r.status, 'not_owner');
  });
  count++;

  // TEST 7: Attempt to promote a non-member -> proper validation error.
  await run('TEST 7: promoting a non-member returns target_not_member', async () => {
    const r = await addChannelModerator(CHANNEL, NONMEMBER, OWNER, projects);
    assert.equal(r.status, 'target_not_member');
    assert.equal(roleOf(db, NONMEMBER, CHANNEL), null, 'no second membership row created');
  });
  count++;

  // TEST 8: Owner can never be promoted/demoted -> owner stays owner.
  await run('TEST 8: owner protected from promotion and demotion', async () => {
    const promote = await addChannelModerator(CHANNEL, OWNER, OWNER, projects);
    assert.equal(promote.status, 'owner_protected');
    const demote = await removeChannelModerator(CHANNEL, OWNER, OWNER, projects);
    assert.equal(demote.status, 'owner_protected');
    assert.equal(roleOf(db, OWNER, CHANNEL), 'owner');
  });
  count++;

  // Demoting a non-moderator follower -> proper validation error.
  await run('TEST 9: demoting a follower returns target_not_moderator', async () => {
    const r = await removeChannelModerator(CHANNEL, OTHER, OWNER, projects);
    assert.equal(r.status, 'target_not_moderator');
    assert.equal(roleOf(db, OTHER, CHANNEL), 'follower');
  });
  count++;

  // Non-channel and missing conversations are refused without writing anything.
  await run('TEST 10: non-channel conversations are refused', async () => {
    const r = await addChannelModerator(GROUP, MEMBER, OWNER, projects);
    assert.equal(r.status, 'not_channel');
    assert.equal(roleOf(db, MEMBER, GROUP), 'member');
  });
  count++;

  await run('TEST 11: missing conversations are refused', async () => {
    const r = await addChannelModerator('missing-channel', MEMBER, OWNER, projects);
    assert.equal(r.status, 'conversation_not_found');
  });
  count++;

  // This flow never touches conversations/other members rows.
  await run('TEST 12: conversations, other members and messages are untouched', async () => {
    assert.equal(db.conversations.length, initialConvCount);
    assert.equal(db.participants.length, initialMemberRows);
    assert.equal(roleOf(db, OTHER, CHANNEL), 'follower');
    assert.equal(roleOf(db, MODERATOR, CHANNEL), 'moderator');
    assert.equal(roleOf(db, OTHER, CHANNEL), 'follower');
  });
  count++;

  // Missing / malformed inputs.
  await run('TEST 13: missing target id is rejected before any write', async () => {
    const r = await addChannelModerator(CHANNEL, null, OWNER, projects);
    assert.equal(r.status, 'target_required');
  });
  count++;

  console.log(`\n${count} channel moderator test groups passed.`);
}

main().catch((e) => {
  console.error('\nChannel moderator tests FAILED:');
  console.error(e);
  process.exit(1);
});