// Group tables are hosted per-domain in the existing infrastructure registry
// (groups-1 owns `groups`, group-members-1 owns `group_members`,
// group-posts-1 owns `group_posts`, ...), exactly like every other table the
// Gateway routes. The group feature modules must resolve each table to its own
// project through the existing project manager — they must never assume every
// group table lives on the `groups` host. Querying `group_members` (or the
// moderation tables) through the single `groups` client fails with 42P01 and
// every group operation surfaces as "Group operation failed".
//
// The shared rules/moderation tables (group_rules, group_member_bans,
// group_member_restrictions, group_moderation_actions, group_reports) are
// FK-bound to public.groups(id) (and public.profiles(id)) in the group
// migrations, so they physically live in the same database as `groups`. When
// their dedicated per-domain registry rows are not registered yet, resolving
// them falls back to the `groups` host — the project where the group row and
// these co-located tables actually live. Dedicated domain rows still win once
// they are registered (register_group_domains.sql). This fixes the routing gap
// that threw "No readable projects for domain: <table>" and made every
// moderated operation surface as GROUP_OPERATION_FAILED.
//
// Offline harnesses inject a single mock client that serves every table; the
// injected list wins so those tests keep working unchanged.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';

export type GroupProjects = Array<{ client: SupabaseClient }>;

// Tables co-located with `groups` by FK in the group migrations. Absent a
// registered dedicated domain, they are served by the `groups` host client.
export const GROUP_HOST_FALLBACK_TABLES = new Set([
  'group_rules',
  'group_member_bans',
  'group_member_restrictions',
  'group_moderation_actions',
  'group_reports',
]);

function injectedClient(projects?: GroupProjects | null): SupabaseClient | null {
  return projects && projects.length > 0 ? projects[0].client : null;
}

function groupHostReadClient(): SupabaseClient | null {
  const readable = projectManager.getReadableProjects('groups');
  return readable.length > 0 ? readable[0].client : null;
}

function groupHostWriteClient(): SupabaseClient | null {
  const writable = projectManager.getWritableProject('groups');
  return writable ? writable.client : null;
}

// Read client for a group table (e.g. 'group_members'), resolved by domain from
// the existing registry. Throws a descriptive error when the domain has no
// readable project so the original failure is logged, never masked.
export function groupReadClient(table: string, groupId: string, projects?: GroupProjects | null): SupabaseClient {
  const injected = injectedClient(projects);
  if (injected) return injected;
  if (GROUP_HOST_FALLBACK_TABLES.has(table)) {
    try {
      return projectManager.getReadClient(table, groupId).client;
    } catch (error) {
      const host = groupHostReadClient();
      if (host) return host;
      throw error;
    }
  }
  return projectManager.getReadClient(table, groupId).client;
}

// Write client for a group table, resolved by domain from the existing
// registry. Throws when no writable project exists for the domain.
export function groupWriteClient(table: string, projects?: GroupProjects | null): SupabaseClient {
  const injected = injectedClient(projects);
  if (injected) return injected;
  const entry = projectManager.getWritableProject(table);
  if (entry) return entry.client;
  if (GROUP_HOST_FALLBACK_TABLES.has(table)) {
    const host = groupHostWriteClient();
    if (host) return host;
  }
  throw new Error(`No writable project registered for group table '${table}'`);
}