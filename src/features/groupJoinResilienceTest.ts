// Runnable regression test for the group self-join flow against the DEPLOYED
// split registry (no injected client — the real project-manager resolution
// path).
//
// Defect: `addGroupMembers` resolved the optional `group_member_bans` domain
// unconditionally. The production registry registers only
//
//   groups, group_members, group_posts, group_pins, group_follows
//
// so every self-join threw
//   "No readable projects for domain: group_member_bans"
// -> 500 GROUP_OPERATION_FAILED, the membership row was never written, and the
// caller's "Joined" tab stayed empty even though the Join Group button "worked".
//
// These tests install EXACTLY that topology in memory and drive the real
// feature functions: a self-join must succeed without the bans domain, leave
// must work, and the ban gate must still apply whenever the domain IS present.
//
// Run: npm run test:group-join-resilience
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';
import { addGroupMembers, listGroupMembers, removeGroupMember } from './groupMembers';

type Row = Record<string, any>;

const OWNER = 'owner-uuid';
const JOINER = 'joiner-uuid';
const BANNED = 'banned-uuid';
const G1 = 'group-join-resilience';

class Query {
  private filters: Array<[string, unknown]> = [];
  constructor(
    private rows: Row[],
    private op: 'select' | 'insert' | 'update' | 'delete',
    private payload: unknown
  ) {}

  eq(col: string, val: unknown): Query {
    this.filters.push([col, val]);
    return this;
  }
  order(): Query {
    return this;
  }
  limit(): Query {
    return this;
  }
  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const matched = this.matched();
    return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
  }
  then(resolve: (v: unknown) => void, reject?: (e: unknown) => void): void {
    Promise.resolve()
      .then(() => this.execute())
      .then(resolve, reject);
  }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([c, v]) => String(r[c]) === String(v)));
  }
  private async execute(): Promise<{ data: unknown; error: null }> {
    const matched = this.matched();
    if (this.op === 'select') return { data: matched.map((r) => ({ ...r })), error: null };
    if (this.op === 'insert') {
      for (const item of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        this.rows.push({ ...item });
      }
      return { data: this.payload, error: null };
    }
    if (this.op === 'update') {
      for (const r of matched) Object.assign(r, this.payload);
      return { data: matched, error: null };
    }
    for (const r of matched) {
      const i = this.rows.indexOf(r);
      if (i >= 0) this.rows.splice(i, 1);
    }
    return { data: null, error: null };
  }
}

function clientFor(rows: Row[]): SupabaseClient {
  return {
    from: () => ({
      select: () => new Query(rows, 'select', null),
      insert: (payload: unknown) => new Query(rows, 'insert', payload),
      update: (patch: unknown) => new Query(rows, 'update', patch),
      delete: () => new Query(rows, 'delete', null),
    }),
  } as unknown as SupabaseClient;
}

// Mirrors the deployed registry: each domain owns ONLY its table; a domain that
// is not registered resolves to NO client, so `getReadClient` throws exactly like
// production ("No readable projects for domain: X").
function installRegistry(domains: Record<string, Row[]>): Record<string, Row[]> {
  const clients: Record<string, SupabaseClient> = {};
  for (const domain of Object.keys(domains)) clients[domain] = clientFor(domains[domain]);
  const resolve = (table: string): SupabaseClient => {
    const client = clients[table];
    if (!client) throw new Error(`No readable projects for domain: ${table}`);
    return client;
  };
  projectManager.getReadClient = ((table: string) => ({ client: resolve(table), project: {} as any })) as any;
  projectManager.getWritableProject = ((table: string) => {
    const client = clients[table];
    return client ? { client, project: {} as any } : null;
  }) as any;
  projectManager.getReadableProjects = ((table: string) =>
    clients[table] ? [{ client: clients[table], project: {} as any }] : []) as any;
  return domains;
}

function baseData(): Record<string, Row[]> {
  return {
    groups: [
      {
        id: G1,
        name: 'Join Resilience',
        privacy: 'public',
        created_by: OWNER,
        created_at: '2026-01-01T00:00:00Z',
        description: null,
        rules_enabled: false,
      },
    ],
    group_members: [{ group_id: G1, user_id: OWNER, role: 'admin', created_at: '2026-01-01T00:00:00Z' }],
  };
}

async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  console.log(`  PASS  ${name}`);
}

async function main(): Promise<void> {
  // --- Production topology: group_member_bans is NOT registered ---
  {
    const data = installRegistry(baseData());

    await run('TEST 1: self-join succeeds without the group_member_bans domain', async () => {
      const r = await addGroupMembers(G1, JOINER, { user_id: JOINER });
      assert.equal(r.status, 'ok', `expected ok, got ${r.status}`);
      const row = data.group_members.find((m) => m.group_id === G1 && m.user_id === JOINER);
      assert.ok(row, 'membership row must be written');
      assert.equal(row?.role, 'member');
    });

    await run('TEST 2: the joined member is visible to the members list', async () => {
      const r = await listGroupMembers(G1, JOINER);
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.ok(r.members.some((m) => m.user_id === JOINER));
      assert.equal(r.your_access, 'member');
    });

    await run('TEST 3: self-leave succeeds and removes the membership', async () => {
      const r = await removeGroupMember(G1, JOINER, JOINER, {});
      assert.equal(r.status, 'ok');
      if (r.status !== 'ok') return;
      assert.equal(r.left, true);
      assert.equal(data.group_members.some((m) => m.user_id === JOINER), false);
    });
  }

  // --- Ban enforcement still applies whenever the domain IS registered ---
  {
    const domains = baseData();
    domains.group_member_bans = [
      { id: 'ban-1', group_id: G1, user_id: BANNED, status: 'active', expires_at: null, created_at: '2026-01-01T00:00:00Z' },
    ];
    const data = installRegistry(domains);

    await run('TEST 4: an actively banned user is still refused a self-join', async () => {
      const r = await addGroupMembers(G1, BANNED, { user_id: BANNED });
      assert.equal(r.status, 'not_allowed');
      assert.equal(data.group_members.some((m) => m.user_id === BANNED), false);
    });
  }

  console.log('\nAll group self-join resilience tests passed.');
}

main().catch((err) => {
  console.error('Group self-join resilience tests FAILED:', err);
  process.exitCode = 1;
});
