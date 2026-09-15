// Runnable offline test-suite for the gateway-side channel permission system
// (messages.md — Channel Owner/Moderator permissions).
//
// Covers the gateway-owned channel operations with an in-memory Supabase-shaped
// client (a fresh client is used for the "refresh" steps so the *database*
// memory — not a client — is what persists):
//   - deleteChannel   (owner only)
//   - addChannelFollower (owner or moderator; existing members never downgraded)
//   - channel message edit/delete gates (owner/moderator)
//   - channel pin gates (owner/moderator)
//   - removeChannelMember (owner removes anyone; moderator removes followers only)
//
// Run: npm run test:channel-permissions
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deleteChannel } from './deleteChannel';
import { addChannelFollower } from './addChannelFollower';
import { evaluateChannelMessageGate } from './channelMessageGate';
import { evaluatePinPolicy, evaluatePinDeletePolicy } from './channelPinGate';
import { removeChannelMember } from './removeChannelMember';

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

const CHANNEL = 'channel-0001';
const GROUP = 'group-0001';
const DM = 'dm-0001';
const OWNER = 'owner-uuid';
const MOD = 'moderator-uuid';
const MOD2 = 'moderator-two-uuid';
const FOL = 'follower-uuid';
const OTHER = 'other-uuid';
const NONMEMBER = 'nobody-uuid';

function makeDb(): Db {
  return {
    conversations: [
      { id: CHANNEL, type: 'channel', created_by: OWNER },
      { id: GROUP, type: 'group', created_by: OWNER },
      { id: DM, type: 'dm', created_by: OTHER },
    ],
    conversation_participants: [
      { id: 'pc-1', conversation_id: CHANNEL, user_id: OWNER, role: 'owner' },
      { id: 'pc-2', conversation_id: CHANNEL, user_id: MOD, role: 'moderator' },
      { id: 'pc-3', conversation_id: CHANNEL, user_id: MOD2, role: 'moderator' },
      { id: 'pc-4', conversation_id: CHANNEL, user_id: FOL, role: 'follower' },
      { id: 'pc-5', conversation_id: CHANNEL, user_id: OTHER, role: 'follower' },
      { id: 'pg-1', conversation_id: GROUP, user_id: OWNER, role: 'member' },
      { id: 'pg-2', conversation_id: GROUP, user_id: FOL, role: 'member' },
      { id: 'pd-1', conversation_id: DM, user_id: OTHER, role: 'member' },
    ],
    messages: [
      { id: 'msg-1', conversation_id: CHANNEL, sender_id: MOD },
      { id: 'msg-2', conversation_id: CHANNEL, sender_id: OWNER },
      { id: 'msg-3', conversation_id: GROUP, sender_id: OWNER },
    ],
    pinned_messages: [
      { id: 'pin-1', conversation_id: CHANNEL, message_id: 'msg-1', pinned_by: OWNER },
      { id: 'pin-2', conversation_id: DM, message_id: 'msg-3', pinned_by: OTHER },
    ],
    profiles: [
      { id: OWNER, username: 'owner' },
      { id: MOD, username: 'mod' },
      { id: MOD2, username: 'mod2' },
      { id: FOL, username: 'fol' },
      { id: OTHER, username: 'other' },
    ],
  };
}

function makeClient(db: Db) {
  const table = (name: string): Row[] => (db[name] as Row[]) ?? [];
  const selectChain = (name: string): any => {
    const filters: Array<[string, string]> = [];
    const c = {
      select: (_cols: string) => c,
      eq: (col: string, val: string) => { filters.push([col, String(val)]); return c; },
      maybeSingle: async () => {
        const rows = table(name).filter((r) => filters.every(([col, val]) => String(r[col]) === val));
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: { data: Row[]; error: null }) => void) => {
        const rows = table(name).filter((r) => filters.every(([col, val]) => String(r[col]) === val));
        resolve({ data: rows, error: null });
      },
    };
    return c;
  };
  const insertChain = (name: string, payload: Row): any => ({
    then: (resolve: (v: { data: Row[]; error: null }) => void) => {
      table(name).push({ ...payload });
      resolve({ data: [payload], error: null });
    },
  });
  const updateChain = (name: string, patch: Row): any => {
    const filters: Array<[string, string]> = [];
    const c = {
      eq: (col: string, val: string) => { filters.push([col, String(val)]); return c; },
      then: (resolve: (v: { data: null; error: null }) => void) => {
        for (const r of table(name)) {
          if (filters.every(([col, val]) => String(r[col]) === val)) Object.assign(r, patch);
        }
        resolve({ data: null, error: null });
      },
    };
    return c;
  };
  const deleteChain = (name: string): any => {
    const filters: Array<[string, string]> = [];
    const c = {
      eq: (col: string, val: string) => { filters.push([col, String(val)]); return c; },
      then: (resolve: (v: { data: null; error: null }) => void) => {
        for (const t of [...table(name)]) {
          if (filters.every(([col, val]) => String(t[col]) === val)) {
            table(name).splice(table(name).indexOf(t), 1);
          }
        }
        resolve({ data: null, error: null });
      },
    };
    return c;
  };
  return {
    from: (name: string) => ({
      select: (_cols: string) => selectChain(name),
      insert: (payload: Row) => insertChain(name, payload),
      update: (patch: Row) => updateChain(name, patch),
      delete: () => deleteChain(name),
    }),
  } as unknown as SupabaseClient;
}

const projectsFor = (db: Db) => [{ client: makeClient(db) }];
const roleOf = (db: Db, userId: string, conversationId: string): string | null => {
  const row = (db.conversation_participants as Row[]).find(
    (p) => p.conversation_id === conversationId && p.user_id === userId
  );
  return (typeof row?.role === 'string' ? row.role : null) as string | null;
};

let count = 0;
async function run(name: string, fn: () => Promise<void> | void) {
  await fn();
  count++;
  console.log(`  PASS  ${name}`);
}

async function main() {

  // ---------- deleteChannel (owner only) ----------
  const db = makeDb();
  const projects = projectsFor(db);

  await run('DELETE: owner deletes the channel -> ok, conversation removed', async () => {
    const r = await deleteChannel(CHANNEL, OWNER, projects);
    assert.equal(r.status, 'ok');
    assert.equal((db.conversations as Row[]).some((c) => c.id === CHANNEL), false);
  });

  // ---------- addChannelFollower (owner or moderator) ----------
  const db2 = makeDb();
  const projects2 = projectsFor(db2);

  await run('INVITE: owner adds a new follower -> ok', async () => {
    const r = await addChannelFollower(CHANNEL, NONMEMBER, OWNER, projects2);
    assert.equal(r.status, 'ok');
    assert.equal(roleOf(db2, NONMEMBER, CHANNEL), 'follower');
  });

  await run('INVITE: moderator adds a new follower -> ok', async () => {
    const before = (db2.conversation_participants as Row[]).length;
    const r = await addChannelFollower(CHANNEL, OTHER, MOD, projects2);
    assert.equal(r.status, 'ok');
    assert.equal((db2.conversation_participants as Row[]).length, before); // already a follower
    assert.equal(roleOf(db2, OTHER, CHANNEL), 'follower');
  });

  await run('INVITE: moderator targets a non-existent profile -> target_not_found', async () => {
    const r = await addChannelFollower(CHANNEL, 'ghost-uuid', MOD, projects2, projects2);
    assert.equal(r.status, 'target_not_found');
  });

  await run('INVITE: follower caller is denied -> not_authorized', async () => {
    const r = await addChannelFollower(CHANNEL, NONMEMBER, FOL, projects2);
    assert.equal(r.status, 'not_authorized');
  });

  await run('INVITE: non-participant caller -> not_member', async () => {
    const r = await addChannelFollower(CHANNEL, FOL, 'stranger-uuid', projects2);
    assert.equal(r.status, 'not_member');
  });

  const db3 = makeDb();
  const projects3 = projectsFor(db3);
  await run('INVITE: adding an existing moderator never downgrades them', async () => {
    const r = await addChannelFollower(CHANNEL, MOD, OWNER, projects3);
    assert.equal(r.status, 'ok');
    assert.equal(roleOf(db3, MOD, CHANNEL), 'moderator');
  });

  await run('INVITE: group conversation refused -> not_channel', async () => {
    const r = await addChannelFollower(GROUP, FOL, OWNER, projects3);
    assert.equal(r.status, 'not_channel');
  });

  await run('INVITE: missing conversation -> conversation_not_found', async () => {
    const r = await addChannelFollower('missing-channel', FOL, OWNER, projects3);
    assert.equal(r.status, 'conversation_not_found');
  });

  await run('INVITE: missing target id -> target_required', async () => {
    const r = await addChannelFollower(CHANNEL, null, OWNER, projects3);
    assert.equal(r.status, 'target_required');
  });

  // ---------- channel message gates (edit/delete) ----------
  const db4 = makeDb();
  const projects4 = projectsFor(db4);

  await run('MESSAGE: owner edits a channel post -> ok', async () => {
    const r = await evaluateChannelMessageGate('msg-2', OWNER, projects4);
    assert.deepEqual(r.status, 'ok');
    assert.equal(r.channel, true);
  });

  await run('MESSAGE: moderator edits a channel post -> ok', async () => {
    const r = await evaluateChannelMessageGate('msg-1', MOD, projects4);
    assert.equal(r.status, 'ok');
    assert.equal(r.channel, true);
  });

  await run('MESSAGE: follower edits a channel post -> not_authorized', async () => {
    const r = await evaluateChannelMessageGate('msg-1', FOL, projects4);
    assert.equal(r.status, 'not_authorized');
  });

  await run('MESSAGE: follower deletes a channel post -> not_authorized', async () => {
    const r = await evaluateChannelMessageGate('msg-1', FOL, projects4);
    assert.equal(r.status, 'not_authorized');
  });

  await run('MESSAGE: moderator deletes the owner post -> ok', async () => {
    const r = await evaluateChannelMessageGate('msg-2', MOD, projects4);
    assert.equal(r.status, 'ok');
    assert.equal(r.channel, true);
  });

  await run('MESSAGE: group message edit keeps generic behaviour -> ok, channel=false', async () => {
    const r = await evaluateChannelMessageGate('msg-3', OWNER, projects4);
    assert.equal(r.status, 'ok');
    assert.equal(r.channel, false);
  });

  await run('MESSAGE: missing message -> message_not_found', async () => {
    const r = await evaluateChannelMessageGate('missing-msg', OWNER, projects4);
    assert.equal(r.status, 'message_not_found');
  });

  // ---------- channel pin gates (owner/moderator) ----------
  const db5 = makeDb();
  const projects5 = projectsFor(db5);

  await run('PIN: owner pins in a channel -> ok', async () => {
    const r = await evaluatePinPolicy(CHANNEL, OWNER, projects5);
    assert.equal(r.status, 'ok');
    assert.equal(r.channel, true);
  });

  await run('PIN: moderator pins in a channel -> ok', async () => {
    const r = await evaluatePinPolicy(CHANNEL, MOD, projects5);
    assert.equal(r.status, 'ok');
  });

  await run('PIN: follower pins in a channel -> not_authorized', async () => {
    const r = await evaluatePinPolicy(CHANNEL, FOL, projects5);
    assert.equal(r.status, 'not_authorized');
  });

  await run('PIN: DM pin keeps generic behaviour -> ok, channel=false', async () => {
    const r = await evaluatePinPolicy(DM, OTHER, projects5);
    assert.equal(r.status, 'ok');
    assert.equal(r.channel, false);
  });

  await run('PIN: follower unpins a channel row by id -> not_authorized', async () => {
    const r = await evaluatePinDeletePolicy(FOL, { id: 'pin-1' }, projects5);
    assert.equal(r.status, 'not_authorized');
  });

  await run('PIN: follower unpins by message_id -> not_authorized', async () => {
    const r = await evaluatePinDeletePolicy(FOL, { messageId: 'msg-1' }, projects5);
    assert.equal(r.status, 'not_authorized');
  });

  await run('PIN: DM unpin keeps generic behaviour -> ok', async () => {
    const r = await evaluatePinDeletePolicy(OTHER, { id: 'pin-2' }, projects5);
    assert.equal(r.status, 'ok');
  });

  await run('PIN: moderator bulk unpins a channel -> ok', async () => {
    const r = await evaluatePinDeletePolicy(MOD, { conversationId: CHANNEL }, projects5);
    assert.equal(r.status, 'ok');
  });

  // ---------- removeChannelMember (owner anyone; moderator followers only) ----------
  const db6 = makeDb();
  const projects6 = projectsFor(db6);

  await run('REMOVE: owner removes a follower -> ok', async () => {
    const r = await removeChannelMember(CHANNEL, FOL, OWNER, projects6);
    assert.equal(r.status, 'ok');
    assert.equal(roleOf(db6, FOL, CHANNEL), null);
  });

  await run('REMOVE: moderator removes a follower -> ok', async () => {
    const r = await removeChannelMember(CHANNEL, OTHER, MOD, projects6);
    assert.equal(r.status, 'ok');
    assert.equal(roleOf(db6, OTHER, CHANNEL), null);
  });

  await run('REMOVE: moderator removes a moderator -> target_is_moderator', async () => {
    const r = await removeChannelMember(CHANNEL, MOD2, MOD, projects6);
    assert.equal(r.status, 'target_is_moderator');
    assert.equal(roleOf(db6, MOD2, CHANNEL), 'moderator');
  });

  await run('REMOVE: follower removes a member -> not_owner', async () => {
    const db6b = makeDb();
    const r = await removeChannelMember(CHANNEL, OTHER, FOL, projectsFor(db6b));
    assert.equal(r.status, 'not_owner');
  });

  await run('REMOVE: owner removes the owner (self) -> self_removal', async () => {
    const r = await removeChannelMember(CHANNEL, OWNER, OWNER, projects6);
    assert.equal(r.status, 'self_removal');
    assert.equal(roleOf(db6, OWNER, CHANNEL), 'owner');
  });

  await run('REMOVE: moderator removes the owner -> owner_protected', async () => {
    const db6d = makeDb();
    const r = await removeChannelMember(CHANNEL, OWNER, MOD, projectsFor(db6d));
    assert.equal(r.status, 'owner_protected');
    assert.equal(roleOf(db6d, OWNER, CHANNEL), 'owner');
  });

  await run('REMOVE: non-participant caller -> not_member', async () => {
    const r = await removeChannelMember(CHANNEL, FOL, NONMEMBER, projects6);
    assert.equal(r.status, 'not_member');
  });

  await run('REMOVE: owner removes non-participant target -> member_not_found', async () => {
    const r = await removeChannelMember(CHANNEL, NONMEMBER, OWNER, projects6);
    assert.equal(r.status, 'member_not_found');
  });

  await run('REMOVE: self-removal refused -> self_removal', async () => {
    const db6c = makeDb();
    const r = await removeChannelMember(CHANNEL, FOL, FOL, projectsFor(db6c));
    assert.equal(r.status, 'self_removal');
  });

  await run('REMOVE: group conversation refused -> not_channel', async () => {
    const r = await removeChannelMember(GROUP, FOL, OWNER, projects6);
    assert.equal(r.status, 'not_channel');
  });

  console.log(`\n${count} channel-module test groups passed.`);
}

main().catch((e) => {
  console.error('\nChannel permission tests FAILED:');
  console.error(e);
  process.exit(1);
});