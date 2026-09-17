// Runnable offline test-suite for the gateway-side Group settings + "Group
// Rules" operations (message.md).
//
// Before this module, group settings/rules would have been written through the
// generic service-role /:domain routes, which do no authorization. These tests
// drive the real code path with an in-memory Supabase-shaped client and assert
// both the happy paths and every rejection required by message.md's test list:
// required name/privacy, optional description, rules on/off, owner-only rule
// management, and cross-group / impersonation denial.
//
// Run: npm run test:group-settings
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createGroup,
  updateGroupSettings,
  updateGroupCover,
  setGroupRulesEnabled,
  listGroupRules,
  addGroupRule,
  updateGroupRule,
  deleteGroupRule,
  reorderGroupRules,
} from './groupSettings';

type Row = Record<string, any>;
type Db = Record<string, Row[]>;

const OWNER = 'owner-uuid';
const MEMBER = 'member-uuid';
const MODERATOR = 'moderator-uuid';
const NONMEMBER = 'nobody-uuid';
const OTHER_OWNER = 'other-owner-uuid';

const G1 = 'group-1';
const G2 = 'group-2';
const G3 = 'group-legacy';

function makeDb(): Db {
  return {
    groups: [
      { id: G1, name: 'Public Group', description: 'hi', privacy: 'public', rules_enabled: false, created_by: OWNER, created_at: '2026-01-01T00:00:00Z' },
      { id: G2, name: 'Other Group', description: null, privacy: 'private', rules_enabled: true, created_by: OTHER_OWNER, created_at: '2026-01-02T00:00:00Z' },
      // Legacy group with no created_by: ownership comes from the admin membership row.
      { id: G3, name: 'Legacy', description: null, privacy: 'private', rules_enabled: false, created_by: null, created_at: '2026-01-03T00:00:00Z' },
    ],
    group_members: [
      { group_id: G1, user_id: MEMBER, role: 'member', created_at: '2026-01-01T00:00:00Z' },
      { group_id: G1, user_id: MODERATOR, role: 'moderator', created_at: '2026-01-01T00:00:00Z' },
      { group_id: G3, user_id: OWNER, role: 'admin', created_at: '2026-01-03T00:00:00Z' },
    ],
    group_rules: [],
  };
}

// Minimal in-memory Supabase query builder covering exactly the calls the
// feature module makes (select/insert/update/delete + eq chains + maybeSingle).
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
        return { data: null, error: null };
      }
      case 'update': {
        for (const r of matched) Object.assign(r, this.payload);
        return { data: null, error: null };
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
      select: (cols: string) => new Query(db, table, 'select', cols),
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

  // --- GROUP NAME / DESCRIPTION / PRIVACY (create) ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 1: empty group name -> creation rejected', async () => {
      const r = await createGroup(OWNER, { name: '', description: '', privacy: 'public' }, projects);
      assert.equal(r.status, 'invalid');
      assert.equal(db.groups.length, 3);
    });
    count++;

    await run('TEST 2: whitespace-only name -> rejected', async () => {
      const r = await createGroup(OWNER, { name: '     ', description: '', privacy: 'public' }, projects);
      assert.equal(r.status, 'invalid');
      assert.equal(db.groups.length, 3);
    });
    count++;

    await run('TEST 3: valid name + empty description -> accepted and trimmed', async () => {
      const r = await createGroup(OWNER, { name: '  My Group  ', description: '   ', privacy: 'public' }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.group.name, 'My Group');
      assert.equal(r.group.description, null, 'empty description stored as NULL');
      assert.equal(r.group.created_by, OWNER);
      assert.equal(r.group.rules_enabled, false);
      assert.equal(db.groups.length, 4);
      const membership = db.group_members.find((m) => m.group_id === r.group.id && m.user_id === OWNER);
      assert.ok(membership, 'creator owner membership created');
      assert.equal(membership?.role, 'admin');
    });
    count++;

    await run('TEST 5: privacy not selected -> rejected', async () => {
      const r = await createGroup(OWNER, { name: 'No Privacy', description: '', privacy: undefined }, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 5b: invalid privacy value -> rejected', async () => {
      const r = await createGroup(OWNER, { name: 'Bad Privacy', description: '', privacy: 'friends' }, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 5c: unauthenticated create -> rejected', async () => {
      const r = await createGroup(undefined, { name: 'X', description: '', privacy: 'public' }, projects);
      assert.equal(r.status, 'not_authenticated');
    });
    count++;

    await run('TEST 6: valid privacy -> accepted', async () => {
      const r = await createGroup(OWNER, { name: 'Closed Group', description: 'd', privacy: 'private' }, projects);
      assert.equal(r.status, 'ok');
    });
    count++;
  }

  // --- GROUP SETTINGS (update) + authorization ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 7: update with empty name -> rejected', async () => {
      const r = await updateGroupSettings(G1, OWNER, { name: '   ', description: 'x', privacy: 'public' }, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 7b: update with invalid privacy -> rejected', async () => {
      const r = await updateGroupSettings(G1, OWNER, { name: 'Okay', description: 'x', privacy: 'secret' }, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 8: owner update with empty description -> accepted, description NULL', async () => {
      const r = await updateGroupSettings(G1, OWNER, { name: 'Renamed', description: '', privacy: 'closed' }, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.group.name, 'Renamed');
      assert.equal(r.group.description, null);
      assert.equal(r.group.privacy, 'closed');
      assert.equal(db.groups.find((g) => g.id === G1)?.name, 'Renamed');
    });
    count++;

    await run('TEST 9: ordinary member cannot update settings -> backend rejects', async () => {
      const r = await updateGroupSettings(G1, MEMBER, { name: 'Hacked', description: '', privacy: 'public' }, projects);
      assert.equal(r.status, 'not_owner');
    });
    count++;

    await run('TEST 10: non-member cannot update settings -> backend rejects', async () => {
      const r = await updateGroupSettings(G1, NONMEMBER, { name: 'Hacked', description: '', privacy: 'public' }, projects);
      assert.equal(r.status, 'not_owner');
    });
    count++;

    await run('TEST 11: legacy group owner resolved from admin membership', async () => {
      const r = await updateGroupSettings(G3, OWNER, { name: 'Legacy Renamed', description: null, privacy: 'public' }, projects);
      assert.equal(r.status, 'ok');
    });
    count++;

    await run('TEST 12: unknown group -> group_not_found', async () => {
      const r = await updateGroupSettings('missing', OWNER, { name: 'X', description: '', privacy: 'public' }, projects);
      assert.equal(r.status, 'group_not_found');
    });
    count++;

    await run('TEST 13: impersonation attempt (owner id in body) is ignored', async () => {
      // The feature module never reads an owner id from the body; a member
      // supplying created_by/owner_id is still just a member.
      const r = await updateGroupSettings(
        G1,
        MEMBER,
        { name: 'Impersonated', description: '', privacy: 'public', created_by: MEMBER, owner_id: MEMBER } as any,
        projects
      );
      assert.equal(r.status, 'not_owner');
    });
    count++;

    await run('TEST 14: rules_enabled toggle is owner-only', async () => {
      const denied = await setGroupRulesEnabled(G1, MEMBER, true, projects);
      assert.equal(denied.status, 'not_owner');
      const bad = await setGroupRulesEnabled(G1, OWNER, 'yes' as any, projects);
      assert.equal(bad.status, 'invalid');
      const ok = await setGroupRulesEnabled(G1, OWNER, true, projects);
      assert.equal(ok.status, 'ok');
      assert.equal(db.groups.find((g) => g.id === G1)?.rules_enabled, true);
    });
    count++;
  }

  // --- GROUP RULES lifecycle + permissions ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 15: rules OFF -> group lists no rules and works normally', async () => {
      const r = await listGroupRules(G1, MEMBER, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.rules.length, 0);
    });
    count++;

    await run('TEST 16: rules ON with zero rules -> still works, empty list', async () => {
      await setGroupRulesEnabled(G1, OWNER, true, projects);
      const r = await listGroupRules(G1, MEMBER, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.rules.length, 0, 'enabling rules does not auto-create rules');
    });
    count++;

    await run('TEST 17: owner adds a rule -> members can view it', async () => {
      const added = await addGroupRule(G1, OWNER, '  Be kind  ', projects);
      assert.equal(added.status, 'ok');
      if (added.status !== 'ok') return;
      assert.equal(added.rules.length, 1);
      assert.equal(added.rules[0].rule_text, 'Be kind');
      assert.equal(added.rules[0].position, 0);
      const visible = await listGroupRules(G1, MEMBER, projects);
      assert.equal(visible.status, 'ok');
      if (visible.status !== 'ok') return;
      assert.equal(visible.rules[0].rule_text, 'Be kind');
    });
    count++;

    await run('TEST 18: second rule gets the next position', async () => {
      const r = await addGroupRule(G1, OWNER, 'No spam', projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.rules[1].position, 1);
    });
    count++;

    await run('TEST 19: empty rule text -> rejected', async () => {
      const r = await addGroupRule(G1, OWNER, '   ', projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 20: ordinary member cannot add a rule -> backend rejects', async () => {
      const r = await addGroupRule(G1, MEMBER, 'Member rule', projects);
      assert.equal(r.status, 'not_owner');
      assert.equal(db.group_rules.length, 2);
    });
    count++;

    await run('TEST 21: moderator cannot manage rules -> backend rejects (owner-only)', async () => {
      const r = await addGroupRule(G1, MODERATOR, 'Mod rule', projects);
      assert.equal(r.status, 'not_owner');
    });
    count++;

    await run('TEST 22: owner edits a rule -> members see updated text', async () => {
      const rules = db.group_rules.filter((r) => r.group_id === G1);
      const target = rules[0];
      const r = await updateGroupRule(G1, OWNER, target.id, 'Be very kind', projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.rules.find((x) => x.id === target.id)?.rule_text, 'Be very kind');
    });
    count++;

    await run('TEST 23: non-owner cannot edit a rule', async () => {
      const target = db.group_rules.find((r) => r.group_id === G1);
      const r = await updateGroupRule(G1, MEMBER, target!.id, 'Nope', projects);
      assert.equal(r.status, 'not_owner');
    });
    count++;

    await run('TEST 24: cross-group rule edit -> rule_not_found', async () => {
      // OTHER_OWNER owns G2; ask G1's endpoint about a G2 rule.
      db.group_rules.push({ id: 'g2-rule', group_id: G2, rule_text: 'Two', position: 0, created_at: '', updated_at: '' });
      const r = await updateGroupRule(G1, OWNER, 'g2-rule', 'Stolen', projects);
      assert.equal(r.status, 'rule_not_found');
    });
    count++;

    await run('TEST 25: unrelated user cannot modify another group\'s rules -> rejected', async () => {
      const r = await addGroupRule(G2, OWNER, 'Intrusion', projects);
      assert.equal(r.status, 'not_owner');
    });
    count++;

    await run('TEST 26: owner reorders rules', async () => {
      const before = db.group_rules.filter((r) => r.group_id === G1).sort((a, b) => a.position - b.position);
      const ids = before.map((r) => r.id).reverse();
      const r = await reorderGroupRules(G1, OWNER, ids, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.deepEqual(r.rules.map((x) => x.id), ids);
      assert.deepEqual(r.rules.map((x) => x.position), [0, 1]);
    });
    count++;

    await run('TEST 27: reorder with a foreign/unknown id -> rejected', async () => {
      const r = await reorderGroupRules(G1, OWNER, ['g2-rule', 'nope'], projects);
      assert.equal(r.status, 'invalid');
    });
    count++;

    await run('TEST 28: owner deletes a rule -> it disappears and positions compact', async () => {
      const rules = db.group_rules.filter((r) => r.group_id === G1).sort((a, b) => a.position - b.position);
      const target = rules[0];
      const r = await deleteGroupRule(G1, OWNER, target.id, projects);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.rules.length, 1);
      assert.equal(r.rules[0].position, 0, 'remaining rule position compacted');
      assert.equal(db.group_rules.find((x) => x.id === target.id), undefined);
    });
    count++;

    await run('TEST 29: non-owner cannot delete a rule', async () => {
      const target = db.group_rules.find((r) => r.group_id === G1);
      const r = await deleteGroupRule(G1, MEMBER, target!.id, projects);
      assert.equal(r.status, 'not_owner');
    });
    count++;

    await run('TEST 30: private group rules are hidden from non-members', async () => {
      const r = await listGroupRules(G2, NONMEMBER, projects);
      assert.equal(r.status, 'forbidden');
    });
    count++;

    await run('TEST 31: public group rules are viewable by non-members', async () => {
      const r = await listGroupRules(G1, NONMEMBER, projects);
      assert.equal(r.status, 'ok');
    });
    count++;

    await run('TEST 32: unauthenticated rule operations are rejected', async () => {
      assert.equal((await listGroupRules(G1, undefined, projects)).status, 'not_authenticated');
      assert.equal((await addGroupRule(G1, undefined, 'x', projects)).status, 'not_authenticated');
      assert.equal((await updateGroupRule(G1, undefined, 'x', 'y', projects)).status, 'not_authenticated');
      assert.equal((await deleteGroupRule(G1, undefined, 'x', projects)).status, 'not_authenticated');
      assert.equal((await reorderGroupRules(G1, undefined, [], projects)).status, 'not_authenticated');
    });
    count++;
  }

  // --- Cover image authorization ---
  {
    const db = makeDb();
    const projects = projectsFor(db);

    await run('TEST 33: owner updates the cover image', async () => {
      const r = await updateGroupCover(G1, OWNER, 'https://cdn/cover.png', projects);
      assert.equal(r.status, 'ok');
      assert.equal(db.groups.find((g) => g.id === G1)?.cover_image, 'https://cdn/cover.png');
    });
    count++;

    await run('TEST 34: ordinary member cannot update the cover image', async () => {
      const r = await updateGroupCover(G1, MEMBER, 'https://cdn/bad.png', projects);
      assert.equal(r.status, 'not_owner');
    });
    count++;

    await run('TEST 35: invalid cover type is rejected', async () => {
      const r = await updateGroupCover(G1, OWNER, 123, projects);
      assert.equal(r.status, 'invalid');
    });
    count++;
  }

  console.log(`\n${count} group settings test groups passed.`);
}

main().catch((e) => {
  console.error('\nGroup settings tests FAILED:');
  console.error(e);
  process.exit(1);
});
