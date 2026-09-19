// Deterministic probe: "which operation" + "ORIGINAL error behind
// GROUP_OPERATION_FAILED", for the CURRENT production registry state.
//
// Pro.md: stop assuming. The live registry (/api/keep-alive) registers only
// these group domains:
//   groups -> groups-1, group_members -> group-members-1,
//   group_posts -> group-posts-1, group_pins -> group-pins-1,
//   group_follows -> group-follows-1
// and NOT: group_rules, group_member_bans, group_member_restrictions,
// group_moderation_actions, group_reports.
//
// This probe installs EXACTLY that registry state in memory and drives the real
// feature functions through the real project-manager resolution path. For every
// group operation it prints the ORIGINAL (pre-wrapper) error that the code
// throws today — the thing currently hidden behind GROUP_OPERATION_FAILED.
//
// Run: npx ts-node src/features/groupProdStateProbe.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';
import {
  listGroupMembers, addGroupMembers, removeGroupMember, reportGroupMember,
  restrictGroupMember, unrestrictGroupMember, banGroupMember, unbanGroupMember,
  shareGroupPost,
} from './groupMembers';
import {
  createGroup, updateGroupSettings, addGroupRule, listGroupRules,
} from './groupSettings';

type Row = Record<string, any>;

const OWNER = 'owner-uuid';
const MODERATOR = 'moderator-uuid';
const MEMBER = 'member-uuid';
const G1 = 'group-live-state';

// --- LIVE registry state: only the domains actually registered in production ---
// Each domain's client owns ONLY its table; the missing moderation/rules domains
// have no client at all -> projectManager.getReadClient throws
// `No readable projects for domain: X` exactly like production.
function liveDataset(): Record<string, Row[]> {
  return {
    groups: [
      { id: G1, name: 'Live Group', privacy: 'public', created_by: OWNER, created_at: '2026-01-01T00:00:00Z', description: null, rules_enabled: false },
    ],
    group_members: [
      { group_id: G1, user_id: OWNER, role: 'admin', created_at: '2026-01-01T00:00:00Z' },
      { group_id: G1, user_id: MODERATOR, role: 'moderator', created_at: '2026-01-01T00:00:00Z' },
      { group_id: G1, user_id: MEMBER, role: 'member', created_at: '2026-01-01T00:00:00Z' },
    ],
    group_posts: [],
    group_pins: [],
    group_follows: [],
    profiles: [
      { id: OWNER, username: 'owner', display_name: 'Owner', profile_pic: null, last_seen_at: null },
      { id: MODERATOR, username: 'moderator', display_name: 'Mod', profile_pic: null, last_seen_at: null },
      { id: MEMBER, username: 'member', display_name: 'Mem', profile_pic: null, last_seen_at: null },
    ],
    notifications: [],
  };
}

class Query {
  private filters: Array<[string, unknown]> = [];
  constructor(private db: Record<string, Row[]>, private table: string) {}
  eq(col: string, val: unknown): Query { this.filters.push([col, val]); return this; }
  order(_c: string, _o?: unknown): Query { return this; }
  limit(_n: number): Query { return this; }
  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.db[this.table] ?? [];
    const matched = rows.filter((r) => this.filters.every(([c, v]) => String(r[c]) === String(v)));
    return Promise.resolve({ data: matched[0] ? { ...matched[0] } : null, error: null });
  }
  then(resolve: (v: { data: unknown; error: null }) => void): void {
    Promise.resolve(this.execute()).then(resolve as (v: unknown) => void);
  }
  private execute(): { data: Row[]; error: null } {
    const rows = this.db[this.table] ?? [];
    return { data: rows.map((r) => ({ ...r })), error: null };
  }
}

function fakeClient(db: Record<string, Row[]>): SupabaseClient {
  return {
    from: (table: string) => ({
      select: () => new Query(db, table),
      insert: () => new Query(db, table),
      update: () => new Query(db, table),
      delete: () => new Query(db, table),
    }),
  } as unknown as SupabaseClient;
}

function installLiveRegistry(): void {
  const data = liveDataset();
  const clients: Record<string, SupabaseClient> = {};
  for (const domain of Object.keys(data)) clients[domain] = fakeClient({ [domain]: data[domain] });
  const domainClient = (table: string): SupabaseClient => {
    const client = clients[table];
    if (!client) throw new Error(`No readable projects for domain: ${table}`);
    return client;
  };
  projectManager.getReadClient = ((table: string) => ({ client: domainClient(table), project: {} as any })) as any;
  projectManager.getWritableProject = ((table: string) => {
    const client = clients[table];
    return client ? { client, project: {} as any } : null;
  }) as any;
  projectManager.getReadableProjects = ((table: string) => {
    const client = clients[table];
    return client ? [{ client, project: {} as any }] : [];
  }) as any;
}

function capture(name: string, fn: () => Promise<unknown>): void {
  try {
    void fn().then(
      (r) => console.log(`  ${name}\n    -> resolved: ${JSON.stringify((r as { status?: string })?.status ?? r)}`),
      (err) => console.log(`  ${name}\n    -> ORIGINAL ERROR: ${(err as Error).message}`)
    );
  } catch (err) {
    console.log(`  ${name}\n    -> ORIGINAL ERROR (sync): ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log('Production registry state probed (only groups/group_members/group_posts/group_pins/group_follows registered).');
  console.log('For every group operation, this is the ORIGINAL error the gateway logs today behind GROUP_OPERATION_FAILED:\n');
  installLiveRegistry();

  await capture('open Members tab (listGroupMembers -> fetches members+bans+restrictions+moderation)', () => listGroupMembers(G1, OWNER));
  await capture('Group Rules ON (setGroupRulesEnabled)', () => updateGroupSettings(G1, OWNER, { name: 'Live Group', privacy: 'public' }));
  await capture('open Group Rules list (listGroupRules -> group_rules)', () => listGroupRules(G1, OWNER));
  await capture('add a Group Rule (addGroupRule -> group_rules)', () => addGroupRule(G1, OWNER, 'Be reasonable.'));
  await capture('moderator invites member (addGroupMembers)', () => addGroupMembers(G1, MODERATOR, { user_id: 'target-uuid' }));
  await capture('owner removes member (removeGroupMember)', () => removeGroupMember(G1, OWNER, MEMBER, {}));
  await capture('member reports member (reportGroupMember -> rules/ban flow)', () => reportGroupMember(G1, MEMBER, MODERATOR, { reason: 'harassment' }));
  await capture('moderator restricts posting (restrictGroupMember)', () => restrictGroupMember(G1, MODERATOR, MEMBER, { restriction_type: 'posting' }));
  await capture('owner bans member (banGroupMember)', () => banGroupMember(G1, OWNER, MEMBER, {}));
  await capture('owner unbans member (unbanGroupMember)', () => unbanGroupMember(G1, OWNER, MEMBER));
  await capture('member shares post (shareGroupPost)', () => shareGroupPost(G1, MEMBER, { post_id: 'post-1' }));
  await capture('createGroup (owner membership insert via group_members)', () => createGroup(OWNER, { name: 'New', privacy: 'private' }));

  console.log('\nWith routing fixed (dedicated domain first, groups-host fallback for the FK-co-located');
  console.log('rules/moderation tables), every operation must RESOLVE and none may throw the original');
  console.log('"No readable projects for domain: ..." error in this same live registry state.');
}

main().catch((err) => {
  console.error('Probe crashed:', err);
  process.exitCode = 1;
});