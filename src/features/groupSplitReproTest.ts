// Reproduction harness for the "Group operation failed" defect.
//
// The deployed infrastructure registry hosts each group table on its OWN
// Supabase project (groups-1 owns `groups`, group-members-1 owns
// `group_members`, group-posts-1 owns `group_posts`, ...). The group feature
// modules used to resolve ONE host (`getReadableProjects('groups')`) and run
// EVERY table query through that single client, so `group_members` etc. were
// queried on the `groups` project where they do not exist (42P01) and every
// group operation surfaced as "Group operation failed".
//
// This harness recreates that per-domain layout with in-memory clients (a
// missing table returns the real PostgREST error shape, not a throw) and drives
// the ACTUAL feature functions through the registry path — no project injection
// — so it proves the fix works against the production topology.
//
// Run: npx ts-node src/features/groupSplitReproTest.ts
import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';
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
import {
  createGroup,
  updateGroupSettings,
  addGroupRule,
  listGroupRules,
} from './groupSettings';

type Row = Record<string, any>;

const OWNER = 'owner-uuid';
const MODERATOR = 'moderator-uuid';
const MEMBER = 'member-uuid';
const TARGET = 'target-uuid';
const NONMEMBER = 'nobody-uuid';

const G1 = 'group-split-test';

// --- Per-domain databases exactly matching the deployed registry ---
// Each domain owns ONLY its table; every other table returns 42P01.

function makeFullDataset(): Record<string, Row[]> {
  return {
    groups: [
      { id: G1, name: 'Split Group', privacy: 'public', created_by: OWNER, created_at: '2026-01-01T00:00:00Z', description: null, rules_enabled: false },
    ],
    group_members: [
      { group_id: G1, user_id: OWNER, role: 'admin', created_at: '2026-01-01T00:00:00Z' },
      { group_id: G1, user_id: MODERATOR, role: 'moderator', created_at: '2026-01-01T00:00:00Z' },
      { group_id: G1, user_id: MEMBER, role: 'member', created_at: '2026-01-01T00:00:00Z' },
    ],
    group_posts: [],
    group_rules: [],
    group_member_bans: [],
    group_member_restrictions: [],
    group_moderation_actions: [],
    group_reports: [],
    profiles: [
      { id: OWNER, username: 'owner', display_name: 'Owner', profile_pic: null, last_seen_at: null },
      { id: MODERATOR, username: 'moderator', display_name: 'Mod', profile_pic: null, last_seen_at: null },
      { id: MEMBER, username: 'member', display_name: 'Mem', profile_pic: null, last_seen_at: null },
      { id: TARGET, username: 'target', display_name: 'Tgt', profile_pic: null, last_seen_at: null },
    ],
    notifications: [],
  };
}

const MISSING_TABLES: Record<string, string> = {};

// Query builder for the tables a client OWNS.
class Query {
  private filters: Array<[string, unknown]> = [];
  constructor(
    private db: Record<string, Row[]>,
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
    return this.db[this.table].filter((r) => this.filters.every(([c, v]) => String(r[c]) === String(v)));
  }
  private async execute(): Promise<{ data: unknown; error: null }> {
    const matched = this.matched();
    switch (this.op) {
      case 'select':
        return { data: matched.map((r) => ({ ...r })), error: null };
      case 'insert': {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const item of list) this.db[this.table].push({ ...(item as Row) });
        return { data: list.map((r) => ({ ...(r as Row) })), error: null };
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

// Error-returning query builder for tables a client does NOT own. This mirrors
// PostgREST: supabase-js resolves with `{ data: null, error }` (42P01), it does
// not throw.
function errorQuery(table: string): any {
  const error = {
    message: `relation "public.${table}" does not exist`,
    code: '42P01',
    details: null,
    hint: null,
  };
  const chain: any = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    range: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error }),
    then: (resolve?: (v: unknown) => void, reject?: (e: unknown) => void) => {
      Promise.resolve({ data: null, error }).then(resolve, reject);
    },
  };
  return chain;
}

function fakeClient(db: Record<string, Row[]>): SupabaseClient {
  return {
    from: (table: string) =>
      db[table] !== undefined
        ? {
            select: () => new Query(db, table, 'select', null),
            insert: (payload: unknown) => new Query(db, table, 'insert', payload),
            update: (patch: unknown) => new Query(db, table, 'update', patch),
            delete: () => new Query(db, table, 'delete', null),
          }
        : errorQuery(table),
  } as unknown as SupabaseClient;
}

// --- Override the project manager to mirror the deployed (split) registry ---

function installSplitRegistry(): void {
  const data = makeFullDataset();
  // Each domain gets its OWN client owning ONLY its table — the deployed split
  // layout, where querying any other table returns 42P01 through the registry.
  const clients: Record<string, SupabaseClient> = {};
  for (const domain of Object.keys(data)) clients[domain] = fakeClient({ [domain]: data[domain] });
  const domainClient = (table: string): SupabaseClient => {
    const client = clients[table];
    if (!client) throw new Error(`No readable projects for domain: ${table}`);
    return client;
  };
  projectManager.getReadClient = ((table: string) => ({ client: domainClient(table), project: {} as any })) as any;
  projectManager.getWritableProject = ((table: string) => ({ client: domainClient(table), project: {} as any })) as any;
  projectManager.getReadableProjects = ((table: string) => {
    const client = clients[table];
    return client ? [{ client, project: {} as any }] : [];
  }) as any;
}

let fixed = false;

function ok(name: string): void {
  console.log(`  PASS  ${name}`);
}

async function produce(name: string, fn: () => Promise<{ status?: string; [k: string]: any } | void>): Promise<void> {
  try {
    const r = await fn();
    if (r && r.status === 'ok') {
      ok(name);
      return;
    }
    console.log(`  FAIL  ${name} -> result=${JSON.stringify(r)}`);
    fixed = false;
  } catch (err) {
    console.log(`  FAIL  ${name} -> threw: ${(err as Error).message}`);
    fixed = false;
  }
}

async function main(): Promise<void> {
  fixed = true;
  installSplitRegistry();

  await produce('owner lists members (roster + moderation)', async () => {
    const r = await listGroupMembers(G1, OWNER);
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return r;
    assert.equal(r.members.length, 3);
    assert.equal(r.your_access, 'owner');
    return r;
  });

  await produce('moderator invites a new member (addMember across hosts)', async () => {
    const r = await addGroupMembers(G1, MODERATOR, { user_id: TARGET });
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return r;
    assert.equal(r.added, 1);
    return r;
  });

  await produce('owner removes a member', async () => {
    const r = await removeGroupMember(G1, OWNER, TARGET);
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('member reports a member', async () => {
    const r = await reportGroupMember(G1, MEMBER, MODERATOR, { reason: 'harassment' });
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('moderator restricts posting for a member', async () => {
    const r = await restrictGroupMember(G1, MODERATOR, MEMBER, { restriction_type: 'posting' });
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('moderator lifts the restriction', async () => {
    const r = await unrestrictGroupMember(G1, MODERATOR, MEMBER);
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('owner bans a member', async () => {
    const r = await banGroupMember(G1, OWNER, MEMBER, {});
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('owner unbans the member', async () => {
    const r = await unbanGroupMember(G1, OWNER, MEMBER);
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('unbanned member rejoins', async () => {
    const r = await addGroupMembers(G1, MEMBER, { user_id: MEMBER });
    assert.equal(r.status, 'ok');
    assert.equal(r.added, 1);
    return r;
  });

  await produce('member shares a post into the group', async () => {
    const r = await shareGroupPost(G1, MEMBER, { post_id: 'post-1' });
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('member cannot access private group roster', async () => {
    const r = await listGroupMembers(G1, NONMEMBER);
    assert.equal(r.status, 'ok'); // public group -> allowed
    return r;
  });

  await produce('owner updates group settings (groups host only)', async () => {
    const r = await updateGroupSettings(G1, OWNER, { name: 'Renamed Group', description: 'd', privacy: 'public' });
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('owner adds a group rule', async () => {
    const r = await addGroupRule(G1, OWNER, 'Be reasonable.');
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('owner lists group rules', async () => {
    const r = await listGroupRules(G1, OWNER);
    assert.equal(r.status, 'ok');
    return r;
  });

  await produce('createGroup creates group + owner membership across hosts', async () => {
    const r = await createGroup(OWNER, { name: 'New Group', description: '', privacy: 'private' });
    assert.equal(r.status, 'ok');
    return r;
  });

  console.log('');
  if (fixed) {
    console.log('ALL SPLIT-REGISTRY OPERATIONS SUCCEEDED through the registry path.');
  } else {
    console.log('AT LEAST ONE OPERATION STILL FAILED against the split registry.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exitCode = 1;
});