// Gateway-owned Group settings + "Group Rules" operations (message.md).
//
// The standalone Groups feature stored its rows via the generic service-role
// /:domain routes, which perform NO authorization: any authenticated caller
// could rewrite any group's name/privacy, or manage any group's rules. This
// module makes the Gateway the single choke point and resolves every identity
// from the database, never from the request body:
//
//   * GROUP NAME    -> required, trimmed, whitespace-only rejected
//   * DESCRIPTION   -> optional, empty stored as NULL
//   * PRIVACY       -> required, restricted to the existing privacy values
//   * GROUP RULES   -> optional feature; owner-managed ordered list, members
//                      read-only. Enabling the feature never auto-creates rules.
//
// Authorization model (server-side, derived from rows):
//   * owner  = groups.created_by === caller  OR  group_members.role = 'admin'
//              (the existing app role for a group's creator/administrator)
//   * member = any other group_members row for the caller
//   * none   = everyone else
// Only the owner may change settings or rules. A caller-supplied owner id is
// never read, so impersonation is impossible.
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { projectManager } from '../project-manager';
import { groupReadClient, groupWriteClient, type GroupProjects } from './groupHosts';

export const GROUP_PRIVACY_VALUES = ['public', 'private', 'closed'] as const;
export type GroupPrivacy = (typeof GROUP_PRIVACY_VALUES)[number];

export type GroupAccess = 'owner' | 'member' | 'none';

export interface GroupRecord {
  id: string;
  name: string;
  description: string | null;
  privacy: string;
  rules_enabled: boolean;
  created_by: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface GroupRuleRecord {
  id: string;
  group_id: string;
  rule_text: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export type CreateGroupResult =
  | { status: 'ok'; group: GroupRecord }
  | { status: 'not_authenticated' }
  | { status: 'invalid'; message: string }
  | { status: 'unavailable' };

export type UpdateGroupSettingsResult =
  | { status: 'ok'; group: GroupRecord }
  | { status: 'not_authenticated' }
  | { status: 'group_not_found' }
  | { status: 'not_owner' }
  | { status: 'invalid'; message: string };

export type GroupRulesResult =
  | { status: 'ok'; rules: GroupRuleRecord[] }
  | { status: 'not_authenticated' }
  | { status: 'group_not_found' }
  | { status: 'not_owner' }
  | { status: 'forbidden' }
  | { status: 'rule_not_found' }
  | { status: 'invalid'; message: string };

// --- Validation (shared shape with the frontend, enforced again here) ---

export function normalizeGroupName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeGroupDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeRuleText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function isValidPrivacy(value: unknown): value is GroupPrivacy {
  return typeof value === 'string' && (GROUP_PRIVACY_VALUES as readonly string[]).includes(value);
}

// --- Host + access resolution ---

// `client` is the client that owns the `groups` table. Every OTHER group table
// (group_members, group_rules, ...) lives on its OWN project in the deployed
// registry and is resolved per-domain — see groupReadClient / groupWriteClient.
type HostContext = { client: SupabaseClient; group: GroupRecord; projects?: GroupProjects | null };

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
      if (data) return { client: entry.client, group: data as GroupRecord, projects: projects ?? null };
    } catch {
      // Try the next readable host (sharded deployments).
    }
  }
  return null;
}

// Resolve the caller's relationship to a group from the database alone.
export async function resolveGroupAccess(ctx: HostContext, userId: string): Promise<GroupAccess> {
  const group = ctx.group;
  if (group.created_by && group.created_by === userId) return 'owner';
  try {
    const client = groupReadClient('group_members', group.id, ctx.projects);
    const { data } = await client
      .from('group_members')
      .select('role')
      .eq('group_id', group.id)
      .eq('user_id', userId)
      .maybeSingle();
    const role = (data as { role?: string | null } | null)?.role ?? null;
    if (!role) return 'none';
    // 'admin' is the existing app role for a group's administrator/owner.
    return role === 'admin' ? 'owner' : 'member';
  } catch {
    return 'none';
  }
}

async function fetchRules(ctx: HostContext): Promise<GroupRuleRecord[]> {
  const client = groupReadClient('group_rules', ctx.group.id, ctx.projects);
  const { data, error } = await client.from('group_rules').select('*').eq('group_id', ctx.group.id);
  if (error) throw new Error(`Failed to load group rules: ${error.message}`);
  const rules = ((data as GroupRuleRecord[] | null) || []).slice();
  rules.sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
  );
  return rules;
}

// --- Create (GROUP NAME + DESCRIPTION + PRIVACY) ---

export async function createGroup(
  callerUserId: string | undefined,
  input: { name?: unknown; description?: unknown; privacy?: unknown },
  projects?: GroupProjects | null
): Promise<CreateGroupResult> {
  if (!callerUserId) return { status: 'not_authenticated' };

  const name = normalizeGroupName(input?.name);
  if (!name) return { status: 'invalid', message: 'Group name is required.' };
  if (!isValidPrivacy(input?.privacy)) {
    return { status: 'invalid', message: 'A valid privacy setting is required.' };
  }
  const description = normalizeGroupDescription(input?.description);

  const host = projects && projects.length > 0
    ? projects[0]
    : projectManager.getWritableProject('groups');
  if (!host) return { status: 'unavailable' };

  const group: GroupRecord = {
    id: randomUUID(),
    name,
    description,
    privacy: input.privacy,
    rules_enabled: false,
    created_by: callerUserId,
    created_at: new Date().toISOString(),
  };

  const { error } = await host.client.from('groups').insert({
    id: group.id,
    name: group.name,
    description: group.description,
    privacy: group.privacy,
    rules_enabled: false,
    created_by: callerUserId,
  });
  if (error) throw new Error(`Failed to create group: ${error.message}`);

  // The creator becomes the group owner via the existing membership table,
  // which lives on its own project.
  const { error: memberError } = await groupWriteClient('group_members', projects)
    .from('group_members')
    .insert({ group_id: group.id, user_id: callerUserId, role: 'admin' });
  if (memberError) throw new Error(`Failed to create group owner membership: ${memberError.message}`);

  return { status: 'ok', group };
}

// --- Update settings (GROUP NAME + DESCRIPTION + PRIVACY), owner only ---

export async function updateGroupSettings(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  patch: { name?: unknown; description?: unknown; privacy?: unknown },
  projects?: GroupProjects | null
): Promise<UpdateGroupSettingsResult> {
  if (!callerUserId) return { status: 'not_authenticated' };

  const name = normalizeGroupName(patch?.name);
  if (!name) return { status: 'invalid', message: 'Group name is required.' };
  if (!isValidPrivacy(patch?.privacy)) {
    return { status: 'invalid', message: 'A valid privacy setting is required.' };
  }
  const description = normalizeGroupDescription(patch?.description);

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const access = await resolveGroupAccess(ctx, callerUserId);
  if (access !== 'owner') return { status: 'not_owner' };

  const { error } = await ctx.client
    .from('groups')
    .update({ name, description, privacy: patch.privacy })
    .eq('id', ctx.group.id);
  if (error) throw new Error(`Failed to update group settings: ${error.message}`);

  return { status: 'ok', group: { ...ctx.group, name, description, privacy: patch.privacy } };
}

// --- Update the group cover image, owner only ---

export async function updateGroupCover(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  coverImage: unknown,
  projects?: GroupProjects | null
): Promise<UpdateGroupSettingsResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (coverImage !== null && typeof coverImage !== 'string') {
    return { status: 'invalid', message: 'cover_image must be a string or null.' };
  }

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const access = await resolveGroupAccess(ctx, callerUserId);
  if (access !== 'owner') return { status: 'not_owner' };

  const { error } = await ctx.client
    .from('groups')
    .update({ cover_image: coverImage })
    .eq('id', ctx.group.id);
  if (error) throw new Error(`Failed to update group cover: ${error.message}`);

  return { status: 'ok', group: { ...ctx.group, cover_image: coverImage as string | null } };
}

// --- Enable/disable Group Rules, owner only ---
export async function setGroupRulesEnabled(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  enabled: unknown,
  projects?: GroupProjects | null
): Promise<UpdateGroupSettingsResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (typeof enabled !== 'boolean') {
    return { status: 'invalid', message: 'rules_enabled must be a boolean.' };
  }

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const access = await resolveGroupAccess(ctx, callerUserId);
  if (access !== 'owner') return { status: 'not_owner' };

  const { error } = await ctx.client
    .from('groups')
    .update({ rules_enabled: enabled })
    .eq('id', ctx.group.id);
  if (error) throw new Error(`Failed to update group rules setting: ${error.message}`);

  return { status: 'ok', group: { ...ctx.group, rules_enabled: enabled } };
}

// --- List rules: owner + members always; anyone when the group is public ---

export async function listGroupRules(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  projects?: GroupProjects | null
): Promise<GroupRulesResult> {
  if (!callerUserId) return { status: 'not_authenticated' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };

  const access = await resolveGroupAccess(ctx, callerUserId);
  if (access === 'none' && ctx.group.privacy !== 'public') return { status: 'forbidden' };

  const rules = await fetchRules(ctx);
  return { status: 'ok', rules };
}

// --- Add a rule, owner only ---

export async function addGroupRule(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  ruleText: unknown,
  projects?: GroupProjects | null
): Promise<GroupRulesResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  const text = normalizeRuleText(ruleText);
  if (!text) return { status: 'invalid', message: 'Rule text is required.' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };
  const access = await resolveGroupAccess(ctx, callerUserId);
  if (access !== 'owner') return { status: 'not_owner' };

  const current = await fetchRules(ctx);
  const nextPosition = current.length > 0 ? Math.max(...current.map((r) => r.position ?? 0)) + 1 : 0;

  const { error } = await groupWriteClient('group_rules', ctx.projects).from('group_rules').insert({
    id: randomUUID(),
    group_id: ctx.group.id,
    rule_text: text,
    position: nextPosition,
  });
  if (error) throw new Error(`Failed to add group rule: ${error.message}`);

  return { status: 'ok', rules: await fetchRules(ctx) };
}

// --- Edit a rule, owner only ---

export async function updateGroupRule(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  ruleId: string | null | undefined,
  ruleText: unknown,
  projects?: GroupProjects | null
): Promise<GroupRulesResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!ruleId) return { status: 'rule_not_found' };
  const text = normalizeRuleText(ruleText);
  if (!text) return { status: 'invalid', message: 'Rule text is required.' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };
  const access = await resolveGroupAccess(ctx, callerUserId);
  if (access !== 'owner') return { status: 'not_owner' };

  const { data: existing } = await groupReadClient('group_rules', ctx.group.id, ctx.projects)
    .from('group_rules')
    .select('id')
    .eq('id', ruleId)
    .eq('group_id', ctx.group.id)
    .maybeSingle();
  if (!existing) return { status: 'rule_not_found' };

  const { error } = await groupWriteClient('group_rules', ctx.projects)
    .from('group_rules')
    .update({ rule_text: text, updated_at: new Date().toISOString() })
    .eq('id', ruleId)
    .eq('group_id', ctx.group.id);
  if (error) throw new Error(`Failed to update group rule: ${error.message}`);

  return { status: 'ok', rules: await fetchRules(ctx) };
}

// --- Delete a rule, owner only (positions are compacted) ---

export async function deleteGroupRule(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  ruleId: string | null | undefined,
  projects?: GroupProjects | null
): Promise<GroupRulesResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!ruleId) return { status: 'rule_not_found' };

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };
  const access = await resolveGroupAccess(ctx, callerUserId);
  if (access !== 'owner') return { status: 'not_owner' };

  const { data: existing } = await groupReadClient('group_rules', ctx.group.id, ctx.projects)
    .from('group_rules')
    .select('id')
    .eq('id', ruleId)
    .eq('group_id', ctx.group.id)
    .maybeSingle();
  if (!existing) return { status: 'rule_not_found' };

  const { error } = await groupWriteClient('group_rules', ctx.projects)
    .from('group_rules')
    .delete()
    .eq('id', ruleId)
    .eq('group_id', ctx.group.id);
  if (error) throw new Error(`Failed to delete group rule: ${error.message}`);

  const remaining = await fetchRules(ctx);
  for (let i = 0; i < remaining.length; i++) {
    if ((remaining[i].position ?? 0) !== i) {
      await groupWriteClient('group_rules', ctx.projects)
        .from('group_rules')
        .update({ position: i })
        .eq('id', remaining[i].id);
    }
  }

  return { status: 'ok', rules: await fetchRules(ctx) };
}

// --- Reorder rules, owner only ---

export async function reorderGroupRules(
  groupId: string | null | undefined,
  callerUserId: string | undefined,
  orderedIds: unknown,
  projects?: GroupProjects | null
): Promise<GroupRulesResult> {
  if (!callerUserId) return { status: 'not_authenticated' };
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
    return { status: 'invalid', message: 'ordered_ids must be an array of rule ids.' };
  }

  const ctx = await resolveGroupHost(groupId, projects);
  if (!ctx) return { status: 'group_not_found' };
  const access = await resolveGroupAccess(ctx, callerUserId);
  if (access !== 'owner') return { status: 'not_owner' };

  const current = await fetchRules(ctx);
  const existingIds = new Set(current.map((r) => r.id));
  const ids = orderedIds as string[];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!existingIds.has(id) || seen.has(id)) {
      return { status: 'invalid', message: 'ordered_ids must match the group\'s rules exactly.' };
    }
    seen.add(id);
  }
  if (ids.length !== current.length) {
    return { status: 'invalid', message: 'ordered_ids must match the group\'s rules exactly.' };
  }

  for (let i = 0; i < ids.length; i++) {
    const { error } = await groupWriteClient('group_rules', ctx.projects)
      .from('group_rules')
      .update({ position: i, updated_at: new Date().toISOString() })
      .eq('id', ids[i])
      .eq('group_id', ctx.group.id);
    if (error) throw new Error(`Failed to reorder group rules: ${error.message}`);
  }

  return { status: 'ok', rules: await fetchRules(ctx) };
}
