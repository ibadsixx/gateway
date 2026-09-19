// Runnable offline test-suite for the gateway-side Group member management +
// moderation operations (message.md).
//
// Before this module, group membership/posts were written through the generic
// service-role /:domain routes or the browser's RLS client, which perform no
// server-side moderation authorization. These tests drive the real feature
// functions with an in-memory Supabase-shaped client and assert the happy paths
// plus every rejection required by message.md's test list: member roster with
// restriction status, join/invite, leave/remove with owner→moderator→member
// hierarchy, report, restrict/unrestrict, ban/unban (ban removes membership and
// blocks rejoining), and restricted members cannot share posts.
//
// Run: npm run test:group-members
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  listGroupMembers,
  addGroupMembers,
  removeGroupMember,
  reportGroupMember,
  restrictGroupMember,
  unrestrictGroupMember,
  banGroupMember,
  unbanGroupMember,
  shareGroupPost,
} from './groupMembers';

type Row = Record<string, any>;
type Db = Record<string, Row[]>;

const OWNER = 'owner-uuid';
const MODERATOR = 'moderator-uuid';
const MEMBER = 'member-uuid';
const NONMEMBER = 'nobody-uuid';
const STRANGER = 'stranger-uuid';

const G1 = 'group-member-test';
const G1_PRIVATE = 'group-private';
const G1_OWNER = { id: G1, name: 'Member Group', privacy: 'public', created_by: OWNER, created_at: '2026-01-01T00:00:00Z' };
const G1_PRIVATE_ROW = { id: G1_PRIVATE, name: 'Private Group', privacy: 'closed', created_by: OWNER, created_at: '2026-01-01T00:00:00Z' };
const G1_RULE = 'rule-1';

function makeDb(): Db {
  return {
    groups: [G1_OWNER, G1_PRIVATE_ROW],
    group_members: [
      { group_id: G1, user_id: OWNER, role: 'admin', created_at: '2026-01-01T00:00:00Z' },
      { group_id: G1, user_id: MODERATOR, role: 'moderator', created_at: '2026-01-01T00:00:00Z' },
      { group_id: G1, user_id: MEMBER, role: 'member', created_at: '2026-01-01T00:00:00Z' },
    ],
    group_member_bans: [],
    group_member_restrictions: [],
    group_moderation_actions: [],
    group_reports: [],
    group_rules: [
      { id: G1_RULE, group_id: G1, rule_text: 'Be kind', position: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ],
    group_posts: [],
  };
}

// Minimal in-memory Supabase query builder covering exactly the calls the
// feature module makes (select/insert/update/delete + eq chains + order/limit +
// maybeSingle). The groups host has no `profiles`, so profile enrichment is not
// exercised here.
class Query {
  private filters: Array<[string, unknown]> = [];
  constructor(
    private db: Db,
    private table: string,
    private op: 'select' | 'insert' | 'update' | 'delete',
    private payload: unknown
  ) {}

  eq(col: string, val: unknown): Query {
    this.filters.push([col, val]);
    return this;
  }

  order(_col: string, _opts?: unknown): Query {
    return this;
  }

  limit(_n: number): Query {
    return this;
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const matched = this.matched();
    return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
  }

  then(resolve: (v: { data: unknown; error: null }) => void, reject?: (e: unknown) => void): void {
    Promise.resolve()
      .then(() => this.execute())
      .then(resolve as (v: unknown) => void, reject);
  }

  private matched(): Row[] {
    if (!this.db[this.table]) this.db[this.table] = [];
    return this.db[this.table].filter((r) =>
      this.filters.every(([c, v]) => String(r[c]) === String(v))
    );
  }

  private async execute(): Promise<{ data: unknown; error: null }> {
    const matched = this.matched();
    switch (this.op) {
      case 'select':
        return { data: matched.map((r) => ({ ...r })), error: null };
      case 'insert': {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const item of list) this.db[this.table].push({ ...(item as Row) });
        return { data: list, error: null };
      }
      case 'update': {
        for (const r of matched) Object.assign(r, this.payload);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      case 'delete': {
        this.db[this.table] = this.db[this.table].filter((r) => !matched.includes(r));
        return { data: null, error: null };
      }
    }
  }
}

function fakeClient(db: Db): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => new Query(db, table, 'select', null),
      insert: (payload: unknown) => new Query(db, table, 'insert', payload),
      update: (patch: unknown) => new Query(db, table, 'update', patch),
      delete: () => new Query(db, table, 'delete', null),
    }),
  } as unknown as SupabaseClient;
}

const projectsFor = (db: Db) => [{ client: fakeClient(db) }];

async function run(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`  PASS  ${name}`);
}

async function main() {
  let count = 0;

  // --- Members list + roster enrichment ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 1: owner lists members + roster with status', async () => {
      const r = await listGroupMembers(G1, OWNER, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.your_access, 'owner');
      assert.equal(r.members.length, 3);
      assert.ok(r.members.every((m) => m.status === 'active'));
      assert.ok(r.members.every((m) => m.restriction === null));
      assert.deepEqual(r.banned, []);
      assert.deepEqual(r.moderation, []);
    });
    count++;

    await run('TEST 2: ordinary member lists members (no banned/moderation data)', async () => {
      const r = await listGroupMembers(G1, MEMBER, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.your_access, 'member');
      assert.equal(r.members.length, 3);
      assert.deepEqual(r.banned, []);
      assert.deepEqual(r.moderation, []);
    });
    count++;

    await run('TEST 3: non-member can view a public group roster (no admin data)', async () => {
      const r = await listGroupMembers(G1, NONMEMBER, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.your_access, 'none');
      assert.equal(r.members.length, 3);
      assert.deepEqual(r.banned, []);
    });
    count++;

    await run('TEST 4: non-member cannot view a private group roster', async () => {
      const r = await listGroupMembers(G1_PRIVATE, NONMEMBER, projects);
      assert.equal(r.status, 'forbidden');
    });
    count++;

    await run('TEST 5: unknown group -> group_not_found', async () => {
      const r = await listGroupMembers('missing', OWNER, projects);
      assert.equal(r.status, 'group_not_found');
    });
    count++;

    await run('TEST 6: unauthenticated list -> rejected', async () => {
      const r = await listGroupMembers(G1, undefined, projects);
      assert.equal(r.status, 'not_authenticated');
    });
    count++;
  }

  // --- Join / invite ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 7: self-join adds the caller as a member', async () => {
      const r = await addGroupMembers(G1, NONMEMBER, { user_id: NONMEMBER }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.ok(db.group_members.some((m) => m.group_id === G1 && m.user_id === NONMEMBER));
    });
    count++;

    await run('TEST 8: owner invites a non-member', async () => {
      const r = await addGroupMembers(G1, OWNER, { user_ids: [STRANGER] }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.added, 1);
    });
    count++;

    await run('TEST 9: re-adding an existing member is idempotent', async () => {
      const r = await addGroupMembers(G1, OWNER, { user_ids: [MEMBER] }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.added, 0);
    });
    count++;

    await run('TEST 10: ordinary member cannot invite others', async () => {
      const r = await addGroupMembers(G1, MEMBER, { user_ids: [NONMEMBER] }, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 11: no member ids -> invalid', async () => {
      const r = await addGroupMembers(G1, OWNER, {}, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;
  }

  // --- Leave / remove + moderation hierarchy ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 12: member leaves (self-removal)', async () => {
      const r = await removeGroupMember(G1, MEMBER, MEMBER, {}, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.left, true);
      const stillMember = db.group_members.some((m) => m.group_id === G1 && m.user_id === MEMBER);
      assert.equal(stillMember, false);
    });
    count++;

    await run('TEST 13: ordinary member cannot remove another member', async () => {
      const r = await removeGroupMember(G1, MEMBER, MODERATOR, {}, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 14: moderator removes an ordinary member (records history)', async () => {
      db.group_members.push({ group_id: G1, user_id: STRANGER, role: 'member', created_at: '2026-01-01T00:00:00Z' });
      const r = await removeGroupMember(G1, MODERATOR, STRANGER, { reason: 'spam' }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      const stillMember = db.group_members.some((m) => m.group_id === G1 && m.user_id === STRANGER);
      assert.equal(stillMember, false);
      const action = db.group_moderation_actions.find((a) => a.group_id === G1 && a.action === 'remove');
      assert.ok(action, 'moderation action recorded');
      assert.equal(action?.target_user_id, STRANGER);
      assert.equal(action?.actor_id, MODERATOR);
      assert.equal(action?.reason, 'spam');
    });
    count++;

    await run('TEST 15: moderator cannot remove another moderator', async () => {
      const MODERATOR2 = 'moderator2-uuid';
      db.group_members.push({ group_id: G1, user_id: MODERATOR2, role: 'moderator', created_at: '2026-01-01T00:00:00Z' });
      const r = await removeGroupMember(G1, MODERATOR, MODERATOR2, {}, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 16: member cannot remove the owner', async () => {
      const r = await removeGroupMember(G1, MEMBER, OWNER, {}, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 17: owner can remove a moderator', async () => {
      const r = await removeGroupMember(G1, OWNER, MODERATOR, {}, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      const stillMod = db.group_members.some((m) => m.group_id === G1 && m.user_id === MODERATOR);
      assert.equal(stillMod, false);
    });
    count++;

    await run('TEST 18: removing a non-member -> target_not_found', async () => {
      const r = await removeGroupMember(G1, OWNER, NONMEMBER, {}, projects);
      assert.equal(r.status, 'target_not_found');
    });
    count++;
  }

  // --- Report ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 19: member reports another member', async () => {
      const r = await reportGroupMember(G1, MEMBER, MODERATOR, { reason: 'harassment', description: 'Keeps pinging me' }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      const report = db.group_reports.find((x) => x.group_id === G1);
      assert.ok(report);
      assert.equal(report?.reported_user_id, MODERATOR);
      assert.equal(report?.reporter_user_id, MEMBER);
      assert.equal(report?.reason, 'harassment');
      assert.equal(report?.status, 'pending');
    });
    count++;

    await run('TEST 20: invalid report reason -> rejected', async () => {
      const r = await reportGroupMember(G1, MEMBER, MODERATOR, { reason: 'random' }, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 21: cannot report yourself', async () => {
      const r = await reportGroupMember(G1, MEMBER, MEMBER, { reason: 'harassment' }, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 22: non-member cannot report', async () => {
      const r = await reportGroupMember(G1, NONMEMBER, MEMBER, { reason: 'harassment' }, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 23: report on a non-member -> target_not_found', async () => {
      const r = await reportGroupMember(G1, MEMBER, NONMEMBER, { reason: 'harassment' }, projects);
      assert.equal(r.status, 'target_not_found');
    });
    count++;
  }

  // --- Restrict / unrestrict ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 24: owner restricts a member from posting (ties to a rule)', async () => {
      const r = await restrictGroupMember(G1, OWNER, MEMBER, {
        restriction_type: 'posting',
        ends_at: '2099-01-01T00:00:00Z',
        reason: 'Rule violation',
        rule_id: G1_RULE,
      }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      const restriction = db.group_member_restrictions.find((x) => x.group_id === G1 && x.user_id === MEMBER);
      assert.ok(restriction);
      assert.equal(restriction?.restriction_type, 'posting');
      assert.equal(restriction?.rule_id, G1_RULE);
      const action = db.group_moderation_actions.find((a) => a.action === 'restrict');
      assert.ok(action);
      assert.equal(action?.rule_id, G1_RULE);
      assert.equal(action?.ends_at, '2099-01-01T00:00:00.000Z');
    });
    count++;

    await run('TEST 25: duplicate active restriction of the same type -> rejected', async () => {
      const r = await restrictGroupMember(G1, OWNER, MEMBER, { restriction_type: 'posting' }, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 26: invalid restriction type -> invalid', async () => {
      const r = await restrictGroupMember(G1, OWNER, MEMBER, { restriction_type: 'shadow' }, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 27: moderator cannot restrict a moderator', async () => {
      const r = await restrictGroupMember(G1, MODERATOR, MODERATOR, { restriction_type: 'posting' }, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 28: restricting with a foreign rule id -> rule_not_found', async () => {
      const r = await restrictGroupMember(G1, OWNER, MEMBER, { restriction_type: 'all', rule_id: 'other-rule' }, projects);
      assert.equal(r.status, 'rule_not_found');
    });
    count++;

    await run('TEST 29: ordinary member cannot restrict', async () => {
      const r = await restrictGroupMember(G1, MEMBER, MODERATOR, { restriction_type: 'posting' }, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 30: owner lifts the posting restriction', async () => {
      const r = await unrestrictGroupMember(G1, OWNER, MEMBER, {}, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      const restriction = db.group_member_restrictions.find((x) => x.group_id === G1 && x.user_id === MEMBER);
      assert.equal(restriction?.status, 'revoked');
      const action = db.group_moderation_actions.find((a) => a.action === 'unrestrict');
      assert.ok(action);
    });
    count++;

    await run('TEST 31: unrestricting someone with no active restriction -> invalid', async () => {
      const r = await unrestrictGroupMember(G1, OWNER, NONMEMBER, {}, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;
  }

  // --- Ban / unban ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 32: owner bans a member -> membership row removed + ban active', async () => {
      const r = await banGroupMember(G1, OWNER, MEMBER, { reason: 'spam abuse' }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      const stillMember = db.group_members.some((m) => m.group_id === G1 && m.user_id === MEMBER);
      assert.equal(stillMember, false, 'ban removes membership');
      const ban = db.group_member_bans.find((b) => b.group_id === G1 && b.user_id === MEMBER);
      assert.ok(ban);
      assert.equal(ban?.status, 'active');
      assert.equal(ban?.reason, 'spam abuse');
    });
    count++;

    await run('TEST 33: banned user cannot rejoin', async () => {
      const r = await addGroupMembers(G1, MEMBER, { user_id: MEMBER }, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 34: owner cannot ban a second time while active', async () => {
      const r = await banGroupMember(G1, OWNER, MEMBER, {}, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 35: moderator cannot ban the owner', async () => {
      const r = await banGroupMember(G1, MODERATOR, OWNER, {}, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 36: cannot ban yourself', async () => {
      const r = await banGroupMember(G1, OWNER, OWNER, {}, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 37: ordinary member cannot ban', async () => {
      const r = await banGroupMember(G1, MEMBER, MODERATOR, {}, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 38: owner unbans -> ban revoked and the user can rejoin', async () => {
      const r = await unbanGroupMember(G1, OWNER, MEMBER, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      const ban = db.group_member_bans.find((b) => b.group_id === G1 && b.user_id === MEMBER);
      assert.equal(ban?.status, 'revoked');
      const action = db.group_moderation_actions.find((a) => a.action === 'unban');
      assert.ok(action, 'unban recorded in moderation history');
      const rejoined = await addGroupMembers(G1, MEMBER, { user_id: MEMBER }, projects);
      assert.equal(rejoined.status, 'ok');
    });
    count++;

    await run('TEST 39: unbanning with no active ban -> invalid', async () => {
      const r = await unbanGroupMember(G1, OWNER, NONMEMBER, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;
  }

  // --- Share posts + restriction gate ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 40: member shares a post into the group', async () => {
      const r = await shareGroupPost(G1, MEMBER, { post_id: 'post-1', message: 'Check this' }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      const post = db.group_posts.find((p) => p.group_id === G1 && p.post_id === 'post-1');
      assert.ok(post);
      assert.equal(post?.shared_by, MEMBER);
      assert.equal(post?.message, 'Check this');
    });
    count++;

    await run('TEST 41: restricted member cannot share posts', async () => {
      await restrictGroupMember(G1, OWNER, MEMBER, { restriction_type: 'posting' }, projects);
      const r = await shareGroupPost(G1, MEMBER, { post_id: 'post-2' }, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 42: non-member cannot share posts', async () => {
      const r = await shareGroupPost(G1, NONMEMBER, { post_id: 'post-3' }, projects);
      assert.equal(r.status, 'not_allowed');
    });
    count++;

    await run('TEST 43: duplicate share is idempotent', async () => {
      await unrestrictGroupMember(G1, OWNER, MEMBER, {}, projects);
      const r = await shareGroupPost(G1, MEMBER, { post_id: 'post-1' }, projects);
      assert.equal(r.status, 'ok');
      assert.equal(r.affected, 'already_shared');
    });
    count++;
  }

  console.log(`\n${count} group member management test groups passed.`);
}

main().catch((e) => {
  console.error('\nGroup member management tests FAILED:');
  console.error(e);
  process.exit(1);
});