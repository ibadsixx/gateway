// Group tables are hosted per-domain in the existing infrastructure registry
// (groups-1 owns `groups`, group-members-1 owns `group_members`,
// group-posts-1 owns `group_posts`, ...), exactly like every other table the
// Gateway routes. The group feature modules must resolve each table to its own
// project through the existing project manager — they must never assume every
// group table lives on the `groups` host. Querying `group_members` (or the
// moderation tables) through the single `groups` client fails with 42P01 and
// every group operation surfaces as "Group operation failed".
//
// Offline harnesses inject a single mock client that serves every table; the
// injected list wins so those tests keep working unchanged.
import type { SupabaseClient } from '@supabase/supabase-js';
import { projectManager } from '../project-manager';

export type GroupProjects = Array<{ client: SupabaseClient }>;

function injectedClient(projects?: GroupProjects | null): SupabaseClient | null {
  return projects && projects.length > 0 ? projects[0].client : null;
}

// Read client for a group table (e.g. 'group_members'), resolved by domain from
// the existing registry. Throws a descriptive error when the domain has no
// readable project so the original failure is logged, never masked.
export function groupReadClient(table: string, groupId: string, projects?: GroupProjects | null): SupabaseClient {
  const injected = injectedClient(projects);
  if (injected) return injected;
  return projectManager.getReadClient(table, groupId).client;
}

// Write client for a group table, resolved by domain from the existing
// registry. Throws when no writable project exists for the domain.
export function groupWriteClient(table: string, projects?: GroupProjects | null): SupabaseClient {
  const injected = injectedClient(projects);
  if (injected) return injected;
  const entry = projectManager.getWritableProject(table);
  if (!entry) throw new Error(`No writable project registered for group table '${table}'`);
  return entry.client;
}