// Gateway-owned Group member management + moderation (message.md).
//
// Before this module, every standalone-Group member write went through the
// generic service-role /:domain routes, which perform NO authorization: any
// authenticated caller could add/remove any member, "ban" someone merely by
// deleting their membership row, or share posts into groups they do not belong
// to. This module makes the Gateway the single choke point for:
//
//   * reading the member roster (+ active restrictions for the UI badge)
//   * joining / inviting members
//   * leaving / removing members
//   * reporting members (mirrors the existing profile_reports rationale)
//   * restricting / unrestricting posting or interactions
//   * banning / unbanning (a ban removes the membership row; banned users may
//     NOT rejoin while the ban is active — enforced both here and by a DB
//     trigger on group_members inserts)
//   * sharing a post into a group (author = caller, and restricted members
//     cannot share)
//
// Every identity and permission is resolved from the database, never from the
// request body:
//   * owner      = groups.created_by === caller  OR  group_members.role = 'admin'
//   * moderator  = group_members.role = 'moderator'
//   * member     = group_members.role = 'member'
//   * none       = everyone else
//
// Moderation matrix (owner outranks moderator outranks member):
//   * owner      may moderate moderators and members, but never self or another
//                 admin/owner
//   * moderator  may moderate members only, never self, the owner, or moderators
//   * members    can report; can remove THEMSELVES (leave) at any time
//
// Ban semantics: creating an active ban removes the membership row and revokes
// active restrictions. Unbanning revokes the ban but does NOT silently restore
// the membership — the user rejoins via the existing join flow.
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { projectManager } from '../project-manager';

export const GROUP_RESTRICTION_TYPES = ['posting', 'all'] as const;
export type GroupRestrictionType = (typeof GROUP_RESTRICTION_TYPES)[number];

export const GROUP_REPORT_REASONS = ['fake_account', 'harassment', 'inappropriate_content', 'other'] as const;
export type GroupReportReason = (typeof GROUP_REPORT_REASONS)[number];

export type ModeratorAccess = 'owner' | 'moderator' | 'member' | 'none';

export interface GroupRecord {
  id: string;
  name: string;
  privacy: string;
  created_by: string | null;
  [key: string]: unknown;
}

export interface GroupMemberRow {
  group_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

export interface GroupBanRow {
  id: string;
  group_id: string;
  user_id: string;
  banned_by: string | null;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
  status: string;
}

export interface GroupRestrictionRow {
  id: string;
  group_id: string;
  user_id: string;
  restriction_type: string;
  restricted_by: string | null;
  reason: string | null;
  rule_id: string | null;
  starts_at: string;
  ends_at: string | null;
  status: string;
  created_at: string;
}

export interface GroupModerationActionRow {
  id: string;
  group_id: string;
  action: string;
  target_user_id: string;
  actor_id: string | null;
  reason: string | null;
  rule_id: string | null;
  ends_at: string | null;
  created_at: string;
}

export interface GroupProfile {
  username: string;
  display_name: string;
  profile_pic: string | null;
  last_seen_at: string | null;
}

export interface EnrichedMember {
  group_id: string;
  user_id: string;
  role: string;
  created_at: string;
  profiles: GroupProfile | null;
  restriction: {
    restriction_type: GroupRestrictionType;
    ends_at: string | null;
    reason: string | null;
    rule_id: string | null;
    created_at: string;
  } | null;
  status: 'active' | 'posting_restricted' | 'restricted';
}

export type MembersListResult =
  | {
      status: 'ok';
      your_access: ModeratorAccess;
      members: EnrichedMember[];
      banned: GroupBanRow[];
      moderation: GroupModerationActionRow[];
    }
  | { status: 'not_authenticated' }
  | { status: 'group_not_found' }
  | { status: 'forbidden' };

export type MemberActionResult =
  | { status: 'ok'; left?: boolean; added?: number; affected?: string; [key: string]: unknown }
  | { status: 'not_authenticated' }
  | { status: 'group_not_found' }
  | { status: 'not_allowed'; message: string }
  | { status: 'target_not_found' }
  | { status: 'rule_not_found' }
  | { status: 'invalid'; message: string };

type GroupProjects = Array<{ client: SupabaseClient }>;
const GROUP_MODERATION_ACTIONS = new Set(['remove', 'ban', 'unban', 'restrict', 'unrestrict', 'post_removed']);

// --- Host + access resolution (identities come from rows, never the body) ---

type HostContext = { client: SupabaseClient; group: GroupRecord };

async function resolveGroupHost(
  groupId: string | null | undefined,
  projects?: GroupProjects | null
): Promise<HostContext | null> {
  if (!groupId) return null;
  const hosts = projects ?? projectManager.getReadableProjects('groups');
  for (const entry of hosts) {
    try {
      const { data } = await entry.client
        .from('groups')
        .select('*')
        .eq('id', groupId)
        .maybeSingle();
      if (data) return { client: entry.client, group: data as GroupRecord };
    } catch {
      // Try the next readable host (sharded deployments).
    }
  }
  return null;
}

async function resolveModeratorAccess(
  client: SupabaseClient,
  group: Pick<GroupRecord, 'id' | 'created_by'>,
  userId: string
): Promise<ModeratorAccess> {
  if (group.created_by && group.created_by === userId) return 'owner';
  try {
    const { data } = await client
      .from('group_members')
      .select('role')
      .eq('group_id', group.id)
      .eq('user_id', userId)
      .maybeSingle();
    const role = (data as { role?: string | null } | null)?.role ?? null;
    if (!role) return 'none';
    if (role === 'admin') return 'owner';
    if (role === 'moderator') return 'moderator';
    return 'member';
  } catch {
    return 'none';
  }
}

// May `caller` moderate `target`? Runs for remove/restrict/ban. Leaving (self)
// goes through a separate path and is always allowed.
function canModerate(
  callerAccess: ModeratorAccess,
  targetUserId: string,
  targetRole: string | null,
  group: Pick<GroupRecord, 'id' | 'created_by'>
): boolean {
  if (!callerAccess || callerAccess === 'member' || callerAccess === 'none') return false;
  if (targetUserId === group.created_by) return false; // never the owner
  if (targetRole === 'admin') return false; // never another admin/owner
  if (targetRole === 'moderator') return callerAccess === 'owner'; // only the owner
  return true; // ordinary members
}

function isRestrictionActive(row: GroupRestrictionRow, now = Date.now()): boolean {
  return row.status === 'active' && (!row.ends_at || new Date(row.ends_at).getTime() > now);
}

function isBanActive(row: GroupBanRow, now = Date.now()): boolean {
  return row.status === 'active' && (!row.expires_at || new Date(row.expires_at).getTime() > now);
}

// --- Shared reads on the group host ---

async function fetchMembers(client: SupabaseClient, groupId: string): Promise<GroupMemberRow[]> {
  const { data, error } = await client.from('group_members').select('*').eq('group_id', groupId).order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load group members: ${error.message}`);
  return ((data as GroupMemberRow[] | null) || []).slice();
}

async function fetchBans(client: SupabaseClient, groupId: string): Promise<GroupBanRow[]> {
  const { data, error } = await client.from('group_member_bans').select('*').eq('group_id', groupId).order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load group bans: ${error.message}`);
  return ((data as GroupBanRow[] | null) || []).slice();
}

async function fetchRestrictions(client: SupabaseClient, groupId: string): Promise<GroupRestrictionRow[]> {
  const { data, error } = await client.from('group_member_restrictions').select('*').eq('group_id', groupId).order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load group restrictions: ${error.message}`);
  return ((data as GroupRestrictionRow[] | null) || []).slice();
}

async function fetchModeration(client: SupabaseClient, groupId: string, limit = 50): Promise<GroupModerationActionRow[]> {
  const { data, error } = await client.from('group_moderation_actions').select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`Failed to load group moderation history: ${error.message}`);
  return ((data as GroupModerationActionRow[] | null) || []).slice();
}

// Profiles live on the users host, not the groups host, so they are attached
// here after fetching the member rows (mirrors resolveSenderProfile).
async function fetchProfiles(userIds: string[]): Promise<Map<string, GroupProfile>> {
  const map = new Map<string, GroupProfile>();
  if (userIds.length === 0) return map;
  const projects = projectManager.getReadableProjects('profiles');
  for (const entry of projects) {
    try {
      const { data, error } = await entry.client
        .from('profiles')
        .select('id, username, display_name, profile_pic, last_seen_at')
        .in('id', userIds);
      if (error) return map;
      for (const row of (data as any[]) || []) {
        map.set(row.id, {
          username: row.username,
          display_name: row.display_name,
          profile_pic: row.profile_pic ?? null,
          last_seen_at: row.last_seen_at ?? null,
        });
      }
      return map;
    } catch {
      // Try the next readable project.
    }
  }
  return map;
}

// Notifications live on a separate host; delivery is best-effort so a hiccup
// never fails the moderation action itself.
async function notifyGroupMember(
  groupId: string,
  groupName: string,
  params: { user_id: string; actor_id: string; type: string; message: string }
): Promise<void> {
  try {
    const host = projectManager.getWritableProject('notifications');
    if (!host) return;
    await host.client.from('notifications').insert({
      user_id: params.user_id,
      actor_id: params.actor_id,
      type: params.type,
      message: params.message,
      group_id: groupId,
      is_read: false,
    });
    // eslint-disable-next-line no-empty
  } catch {
    // Best effort — the moderation action has already persisted.
  }
}

function isValidRuleId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function ruleBelongsToGroup(client: SupabaseClient, groupId: string, ruleId: string): Promise<boolean> {
  const { data, error } = await client
    .from('group_rules')
    .select('id')
    .eq('id', ruleId)
    .eq('group_id', groupId)
    .maybeSingle();
  if (error) return false;
  return !!data;
}

// --- List members + active restrictions + (admin) bans & moderation history ---

export async function listGroupMembers(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  projects?: GroupProjects | null
): Promise<MembersListResult> {
  if (!callerUserId) return { status: 'not_authenticated' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);
  if (yourAccess === 'none' && ctx.group.privacy !== 'public') return { status: 'forbidden' };

  const isModerator = yourAccess === 'owner' || yourAccess === 'moderator';

  const [members, bans, restrictions, moderation] = await Promise.all([
    fetchMembers(ctx.client, ctx.group.id),
    isModerator ? fetchBans(ctx.client, ctx.group.id) : Promise.resolve([] as GroupBanRow[]),
    fetchRestrictions(ctx.client, ctx.group.id),
    isModerator ? fetchModeration(ctx.client, ctx.group.id) : Promise.resolve([] as GroupModerationActionRow[]),
  ]);

  const profiles = await fetchProfiles(members.map((m) => m.user_id));

  const enriched: EnrichedMember[] = members.map((m) => {
    const restriction = restrictions.find(
      (r) => r.user_id === m.user_id && isRestrictionActive(r)
    );
    return {
      group_id: m.group_id,
      user_id: m.user_id,
      role: m.role,
      created_at: m.created_at,
      profiles: profiles.get(m.user_id) ?? null,
      restriction: restriction
        ? {
            restriction_type: restriction.restriction_type as GroupRestrictionType,
            ends_at: restriction.ends_at,
            reason: restriction.reason,
            rule_id: restriction.rule_id,
            created_at: restriction.created_at,
          }
        : null,
      status: restriction
        ? restriction.restriction_type === 'posting'
          ? 'posting_restricted'
          : 'restricted'
        : 'active',
    };
  });

  if (isModerator) {
    const bannedProfiles = await fetchProfiles(bans.map((b) => b.user_id));
    // Attach profiles onto the returned ban rows for the banned-members list.
    const banned = bans.map((b) => ({ ...b, profiles: bannedProfiles.get(b.user_id) ?? null }));
    return { status: 'ok', your_access: yourAccess, members: enriched, banned, moderation };
  }

  return { status: 'ok', your_access: yourAccess, members: enriched, banned: [], moderation: [] };
}

// --- Join (self) or invite (owner/moderator adds members) ---

export async function addGroupMembers(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  input: { user_id?: unknown; user_ids?: unknown },
  projects?: GroupProjects | null
): Promise<MemberActionResult> {
  if (!callerUserId) return { status: 'not_authenticated' };

  const raw = Array.isArray(input?.user_ids)
    ? (input.user_ids as unknown[])
    : [input?.user_id];
  const ids = Array.from(new Set(raw.filter((id): id is string => typeof id === 'string')));
  if (ids.length === 0) return { status: 'invalid', message: 'At least one member id is required.' };
  if (ids.some((id) => id.length === 0)) return { status: 'invalid', message: 'Member ids are invalid.' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);
  // Anyone may join themselves (the existing app allows any authenticated user
  // to join); only the owner/moderator may add others.
  const isModerator = yourAccess === 'owner' || yourAccess === 'moderator';
  const others = ids.filter((id) => id !== callerUserId);
  if (others.length > 0 && !isModerator) {
    return { status: 'not_allowed', message: 'Only the group owner or moderators can add members.' };
  }

  const existing = await fetchMembers(ctx.client, ctx.group.id);
  const existingSet = new Set(existing.map((m) => m.user_id));
  const bans = await fetchBans(ctx.client, ctx.group.id);

  // A banned user must not rejoin — enforced here and by the DB trigger.
  const banned = bans.find((b) => ids.includes(b.user_id) && isBanActive(b));
  if (banned) {
    return { status: 'not_allowed', message: 'This user is banned from the group and cannot be added.' };
  }

  const toInsert = ids.filter((id) => !existingSet.has(id));
  let added = 0;
  for (const id of toInsert) {
    const { error } = await ctx.client.from('group_members').insert({
      group_id: ctx.group.id,
      user_id: id,
      role: 'member',
    });
    if (error) {
      // The DB trigger rejects banned users even if the read cache was stale.
      throw new Error(`Failed to add group member: ${error.message}`);
    }
    added++;
  }

  return { status: 'ok', added };
}

// --- Leave (self) or remove (owner/moderator, with hierarchy checks) ---

export async function removeGroupMember(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  targetUserId: string | null | undefined,
  options: { reason?: unknown } = {},
  projects?: GroupProjects | null
): Promise<MemberActionResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_not_found' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);

  // Self-removal = leave. Any authenticated member may leave at any time.
  if (targetUserId === callerUserId) {
    const exists = await ctx.client
      .from('group_members')
      .select('user_id')
      .eq('group_id', ctx.group.id)
      .eq('user_id', callerUserId)
      .maybeSingle();
    if (!exists.data) return { status: 'invalid', message: 'You are not a member of this group.' };
    const { error } = await ctx.client
      .from('group_members')
      .delete()
      .eq('group_id', ctx.group.id)
      .eq('user_id', callerUserId);
    if (error) throw new Error(`Failed to leave group: ${error.message}`);
    return { status: 'ok', left: true };
  }

  // Removing someone else requires owner/moderator.
  const target = await ctx.client
    .from('group_members')
    .select('*')
    .eq('group_id', ctx.group.id)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (!target.data) return { status: 'target_not_found' };
  const targetRow = target.data as GroupMemberRow;

  if (yourAccess !== 'owner' && yourAccess !== 'moderator') {
    return { status: 'not_allowed', message: 'Only the group owner or moderators can remove members.' };
  }
  if (!canModerate(yourAccess, targetUserId, targetRow.role, ctx.group)) {
    return { status: 'not_allowed', message: 'You cannot remove this member.' };
  }

  const reason = normalizeOptionalText(options?.reason) ?? null;

  const { error } = await ctx.client
    .from('group_members')
    .delete()
    .eq('group_id', ctx.group.id)
    .eq('user_id', targetUserId);
  if (error) throw new Error(`Failed to remove group member: ${error.message}`);

  await recordModerationAction(ctx.client, ctx.group.id, {
    action: 'remove',
    target_user_id: targetUserId,
    actor_id: callerUserId,
    reason,
    rule_id: null,
    ends_at: null,
    created_at: new Date().toISOString(),
  });
  await notifyGroupMember(ctx.group.id, ctx.group.name, {
    user_id: targetUserId,
    actor_id: callerUserId,
    type: 'group_member_removed',
    message: `You were removed from ${ctx.group.name}.`,
  });

  return { status: 'ok', affected: targetUserId };
}

// --- Report a group member (any member may report; mirrors profile_reports) ---

export async function reportGroupMember(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  targetUserId: string | null | undefined,
  input: { reason?: unknown; description?: unknown },
  projects?: GroupProjects | null
): Promise<MemberActionResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_not_found' };

  if (!(GROUP_REPORT_REASONS as readonly string[]).includes(String(input?.reason ?? ''))) {
    return { status: 'invalid', message: 'A valid report reason is required.' };
  }
  const description = normalizeOptionalText(input?.description);
  if (typeof description === 'string' && description.length > 500) {
    return { status: 'invalid', message: 'Description must be 500 characters or fewer.' };
  }
  if (targetUserId === callerUserId) {
    return { status: 'invalid', message: 'You cannot report yourself.' };
  }

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);
  if (yourAccess === 'none') {
    return { status: 'not_allowed', message: 'You must be a group member to report another member.' };
  }

  const target = await ctx.client
    .from('group_members')
    .select('user_id')
    .eq('group_id', ctx.group.id)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (!target.data) return { status: 'target_not_found' };

  const { error } = await ctx.client.from('group_reports').insert({
    group_id: ctx.group.id,
    reported_user_id: targetUserId,
    reporter_user_id: callerUserId,
    reason: input.reason as string,
    description,
    status: 'pending',
  });
  if (error) throw new Error(`Failed to report group member: ${error.message}`);

  return { status: 'ok', affected: targetUserId };
}

// --- Restrict a member (posting only, or all interactions) ---

export async function restrictGroupMember(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  targetUserId: string | null | undefined,
  input: { restriction_type?: unknown; ends_at?: unknown; reason?: unknown; rule_id?: unknown },
  projects?: GroupProjects | null
): Promise<MemberActionResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_not_found' };

  if (!(GROUP_RESTRICTION_TYPES as readonly string[]).includes(String(input?.restriction_type ?? ''))) {
    return { status: 'invalid', message: 'A valid restriction type is required.' };
  }
  const restrictionType = input.restriction_type as GroupRestrictionType;
  const endsAt = normalizeOptionalDate(input?.ends_at);
  if (input?.ends_at !== undefined && input?.ends_at !== null && !endsAt) {
    return { status: 'invalid', message: 'ends_at must be a valid date.' };
  }
  let reason = normalizeOptionalText(input?.reason);
  let ruleId: string | null = null;
  if (isValidRuleId(input?.rule_id)) {
    const ctxCheck = await resolveGroupHost(groupId, projects);
    if (!ctxCheck) return { status: 'group_not_found' };
    if (!(await ruleBelongsToGroup(ctxCheck.client, ctxCheck.group.id, input.rule_id))) {
      return { status: 'rule_not_found' };
    }
    ruleId = input.rule_id;
  }

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);
  if (yourAccess !== 'owner' && yourAccess !== 'moderator') {
    return { status: 'not_allowed', message: 'Only the group owner or moderators can restrict members.' };
  }

  const target = await ctx.client
    .from('group_members')
    .select('*')
    .eq('group_id', ctx.group.id)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (!target.data) return { status: 'target_not_found' };
  const targetRow = target.data as GroupMemberRow;

  if (!canModerate(yourAccess, targetUserId, targetRow.role, ctx.group)) {
    return { status: 'not_allowed', message: 'You cannot restrict this member.' };
  }

  const restrictions = await fetchRestrictions(ctx.client, ctx.group.id);
  const alreadyActive = restrictions.some(
    (r) => r.user_id === targetUserId && r.restriction_type === restrictionType && isRestrictionActive(r)
  );
  if (alreadyActive) {
    return { status: 'invalid', message: 'This member already has an active restriction of this type.' };
  }
  if (reason === undefined) reason = null;

  const { error } = await ctx.client.from('group_member_restrictions').insert({
    id: randomUUID(),
    group_id: ctx.group.id,
    user_id: targetUserId,
    restriction_type: restrictionType,
    restricted_by: callerUserId,
    reason,
    rule_id: ruleId,
    ends_at: endsAt,
    status: 'active',
  });
  if (error) throw new Error(`Failed to restrict group member: ${error.message}`);

  await recordModerationAction(ctx.client, ctx.group.id, {
    action: 'restrict',
    target_user_id: targetUserId,
    actor_id: callerUserId,
    reason,
    rule_id: ruleId,
    ends_at: endsAt ?? null,
    created_at: new Date().toISOString(),
  });
  await notifyGroupMember(ctx.group.id, ctx.group.name, {
    user_id: targetUserId,
    actor_id: callerUserId,
    type: 'group_member_restricted',
    message:
      restrictionType === 'posting'
        ? `Your posting in ${ctx.group.name} has been temporarily disabled.`
        : `Your access to ${ctx.group.name} has been restricted.`,
  });

  return { status: 'ok', affected: targetUserId };
}

// --- Lift an active restriction ---

export async function unrestrictGroupMember(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  targetUserId: string | null | undefined,
  options: { restriction_type?: unknown } = {},
  projects?: GroupProjects | null
): Promise<MemberActionResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_not_found' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);
  if (yourAccess !== 'owner' && yourAccess !== 'moderator') {
    return { status: 'not_allowed', message: 'Only the group owner or moderators can lift restrictions.' };
  }

  const restrictions = await fetchRestrictions(ctx.client, ctx.group.id);
  const active = restrictions.filter(
    (r) =>
      r.user_id === targetUserId &&
      isRestrictionActive(r) &&
      (options?.restriction_type === undefined ||
        options?.restriction_type === null ||
        r.restriction_type === String(options.restriction_type))
  );
  if (active.length === 0) {
    return { status: 'invalid', message: 'This member has no active restriction to lift.' };
  }

  const now = new Date().toISOString();
  for (const r of active) {
    const { error } = await ctx.client
      .from('group_member_restrictions')
      .update({ status: 'revoked', updated_at: now })
      .eq('id', r.id);
    if (error) throw new Error(`Failed to lift group restriction: ${error.message}`);
  }

  await recordModerationAction(ctx.client, ctx.group.id, {
    action: 'unrestrict',
    target_user_id: targetUserId,
    actor_id: callerUserId,
    reason: null,
    rule_id: null,
    ends_at: null,
    created_at: now,
  });
  await notifyGroupMember(ctx.group.id, ctx.group.name, {
    user_id: targetUserId,
    actor_id: callerUserId,
    type: 'group_member_unrestricted',
    message: `Your access to ${ctx.group.name} has been restored.`,
  });

  return { status: 'ok', affected: targetUserId };
}

// --- Ban a member (removes the membership row; they cannot rejoin while active) ---

export async function banGroupMember(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  targetUserId: string | null | undefined,
  input: { ends_at?: unknown; reason?: unknown; rule_id?: unknown },
  projects?: GroupProjects | null
): Promise<MemberActionResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_not_found' };
  if (targetUserId === callerUserId) {
    return { status: 'not_allowed', message: 'You cannot ban yourself.' };
  }

  const endsAt = normalizeOptionalDate(input?.ends_at);
  if (input?.ends_at !== undefined && input?.ends_at !== null && !endsAt) {
    return { status: 'invalid', message: 'ends_at must be a valid date.' };
  }
  let reason = normalizeOptionalText(input?.reason);
  let ruleId: string | null = null;
  if (isValidRuleId(input?.rule_id)) {
    const ctxCheck = await resolveGroupHost(groupId, projects);
    if (!ctxCheck) return { status: 'group_not_found' };
    if (!(await ruleBelongsToGroup(ctxCheck.client, ctxCheck.group.id, input.rule_id))) {
      return { status: 'rule_not_found' };
    }
    ruleId = input.rule_id;
  }

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);
  if (yourAccess !== 'owner' && yourAccess !== 'moderator') {
    return { status: 'not_allowed', message: 'Only the group owner or moderators can ban members.' };
  }

  const target = await ctx.client
    .from('group_members')
    .select('*')
    .eq('group_id', ctx.group.id)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (target.data) {
    const targetRow = target.data as GroupMemberRow;
    if (!canModerate(yourAccess, targetUserId, targetRow.role, ctx.group)) {
      return { status: 'not_allowed', message: 'You cannot ban this member.' };
    }
  }

  const bans = await fetchBans(ctx.client, ctx.group.id);
  if (bans.some((b) => b.user_id === targetUserId && isBanActive(b))) {
    return { status: 'invalid', message: 'This user is already banned from the group.' };
  }
  if (reason === undefined) reason = null;

  const now = new Date().toISOString();
  const { error } = await ctx.client.from('group_member_bans').insert({
    id: randomUUID(),
    group_id: ctx.group.id,
    user_id: targetUserId,
    banned_by: callerUserId,
    reason,
    expires_at: endsAt,
    status: 'active',
  });
  if (error) throw new Error(`Failed to ban group member: ${error.message}`);

  // Bans supersede membership: drop the membership row if present and revoke
  // any active restrictions.
  if (target.data) {
    const { error: delErr } = await ctx.client
      .from('group_members')
      .delete()
      .eq('group_id', ctx.group.id)
      .eq('user_id', targetUserId);
    if (delErr) throw new Error(`Failed to remove banned member: ${delErr.message}`);
  }
  const restrictions = await fetchRestrictions(ctx.client, ctx.group.id);
  for (const r of restrictions.filter((r) => r.user_id === targetUserId && isRestrictionActive(r))) {
    await ctx.client
      .from('group_member_restrictions')
      .update({ status: 'revoked', updated_at: now })
      .eq('id', r.id);
  }

  await recordModerationAction(ctx.client, ctx.group.id, {
    action: 'ban',
    target_user_id: targetUserId,
    actor_id: callerUserId,
    reason,
    rule_id: ruleId,
    ends_at: endsAt ?? null,
    created_at: now,
  });
  await notifyGroupMember(ctx.group.id, ctx.group.name, {
    user_id: targetUserId,
    actor_id: callerUserId,
    type: 'group_member_banned',
    message: `You have been banned from ${ctx.group.name}.`,
  });

  return { status: 'ok', affected: targetUserId };
}

// --- Unban (revokes the ban; the user rejoins through the normal flow) ---

export async function unbanGroupMember(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  targetUserId: string | null | undefined,
  projects?: GroupProjects | null
): Promise<MemberActionResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!targetUserId) return { status: 'target_not_found' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);
  if (yourAccess !== 'owner' && yourAccess !== 'moderator') {
    return { status: 'not_allowed', message: 'Only the group owner or moderators can unban members.' };
  }

  const bans = await fetchBans(ctx.client, ctx.group.id);
  const active = bans.find((b) => b.user_id === targetUserId && isBanActive(b));
  if (!active) {
    return { status: 'invalid', message: 'This user has no active ban to lift.' };
  }

  const now = new Date().toISOString();
  const { error } = await ctx.client
    .from('group_member_bans')
    .update({ status: 'revoked', updated_at: now })
    .eq('id', active.id);
  if (error) throw new Error(`Failed to unban group member: ${error.message}`);

  await recordModerationAction(ctx.client, ctx.group.id, {
    action: 'unban',
    target_user_id: targetUserId,
    actor_id: callerUserId,
    reason: null,
    rule_id: null,
    ends_at: null,
    created_at: now,
  });
  await notifyGroupMember(ctx.group.id, ctx.group.name, {
    user_id: targetUserId,
    actor_id: callerUserId,
    type: 'group_member_unbanned',
    message: `You have been unbanned from ${ctx.group.name}.`,
  });

  return { status: 'ok', affected: targetUserId };
}

// --- Share a post into a group (author = caller; restricted members blocked) ---

export async function shareGroupPost(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  input: { post_id?: unknown; message?: unknown },
  projects?: GroupProjects | null
): Promise<MemberActionResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (typeof input?.post_id !== 'string' || input.post_id.length === 0) {
    return { status: 'invalid', message: 'post_id is required.' };
  }
  const message = normalizeOptionalText(input?.message);

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const yourAccess = await resolveModeratorAccess(ctx.client, ctx.group, callerUserId);
  if (yourAccess === 'none') {
    return { status: 'not_allowed', message: 'You must be a group member to share a post.' };
  }

  const restrictions = await fetchRestrictions(ctx.client, ctx.group.id);
  const barred = restrictions.some(
    (r) =>
      r.user_id === callerUserId &&
      isRestrictionActive(r) &&
      (r.restriction_type === 'posting' || r.restriction_type === 'all')
  );
  if (barred) {
    return { status: 'not_allowed', message: 'You are restricted from posting in this group.' };
  }

  const existing = await ctx.client
    .from('group_posts')
    .select('*')
    .eq('group_id', ctx.group.id)
    .eq('post_id', input.post_id)
    .eq('shared_by', callerUserId)
    .maybeSingle();
  if (existing.data) return { status: 'ok', affected: 'already_shared' };

  const { error } = await ctx.client.from('group_posts').insert({
    group_id: ctx.group.id,
    post_id: input.post_id,
    shared_by: callerUserId,
    message,
  });
  if (error) {
    if (/restricted/i.test(error.message)) {
      return { status: 'not_allowed', message: 'You are restricted from posting in this group.' };
    }
    throw new Error(`Failed to share post to group: ${error.message}`);
  }

  return { status: 'ok', affected: callerUserId };
}

// --- Shared helpers ---

async function recordModerationAction(
  client: SupabaseClient,
  groupId: string,
  action: {
    action: string;
    target_user_id: string;
    actor_id: string;
    reason: string | null;
    rule_id: string | null;
    ends_at: string | null;
    created_at: string;
  }
): Promise<void> {
  if (!GROUP_MODERATION_ACTIONS.has(action.action)) return;
  const { error } = await client.from('group_moderation_actions').insert({
    id: randomUUID(),
    group_id: groupId,
    action: action.action,
    target_user_id: action.target_user_id,
    actor_id: action.actor_id,
    reason: action.reason,
    rule_id: action.rule_id,
    ends_at: action.ends_at,
    created_at: action.created_at,
  });
  if (error) throw new Error(`Failed to record moderation action: ${error.message}`);
}

function normalizeOptionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeOptionalDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}