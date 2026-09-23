// Gateway-side Story viewer/interaction privacy (do.md).
//
// The generic /:domain routes run with service-role clients (RLS bypassed), so
// these restrictions are the API boundary that enforce:
//   - a non-owner Story viewer receives ONLY their own reaction state
//   - every Story analytics surface (total reactions, reaction list, total
//     views, viewer list) is owner-only
//   - a Story owner cannot create a reaction on their own Story
//   - a Story view is always counted independently of reactions (views !=
//     reactions); the count is bumped gateway-side so no viewer ever needs to
//     read another user's `story_views` rows

import type { SupabaseClient } from '@supabase/supabase-js';

export interface QueryResultRow {
  id: string;
  [key: string]: unknown;
}

// Fields on `stories` rows that carry view analytics (total view count + list
// of viewer ids). A non-owner viewer must never receive them.
const STORY_ANALYTIC_FIELDS = ['views', 'viewed_by'] as const;

function distinctStoryIds(rows: any[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const storyId = row?.story_id;
    if (typeof storyId === 'string' && !ids.includes(storyId)) {
      ids.push(storyId);
    }
  }
  return ids;
}

/**
 * Resolve the owning user_id of the given stories using the SAME project
 * client the rows were read from (story tables share one host per project).
 * Unresolved stories default to "no owner" = deny for analytics reads.
 */
async function resolveStoryOwners(
  client: SupabaseClient,
  storyIds: string[]
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (storyIds.length === 0) return owners;
  try {
    const { data } = await client.from('stories').select('id, user_id').in('id', storyIds);
    for (const row of (data || []) as Array<{ id?: string; user_id?: string }>) {
      if (row && typeof row.id === 'string' && typeof row.user_id === 'string') {
        owners.set(row.id, row.user_id);
      }
    }
  } catch (error) {
    console.error('[storyPrivacy] Failed to resolve story owners:', (error as Error).message);
  }
  return owners;
}

/**
 * GET story_reactions: a non-owner viewer may only see their OWN reaction rows;
 * the Story owner sees every reaction on their own Story (owner analytics).
 */
export async function restrictStoryReactionsRead(
  rows: any[],
  client: SupabaseClient,
  requesterId: string | undefined
): Promise<any[]> {
  if (!requesterId) return [];
  if (rows.length === 0) return rows;
  const owners = await resolveStoryOwners(client, distinctStoryIds(rows));
  return rows.filter((row) => {
    const storyOwner = owners.get(row?.story_id);
    // Story owner: full analytics for their own Story.
    if (storyOwner === requesterId) return true;
    // Viewer: their own reaction only.
    return row?.user_id === requesterId;
  });
}

/**
 * GET story_views: viewer analytics are owner-only. Any viewer who is not the
 * Story owner receives an empty list (Scenario H).
 */
export async function restrictStoryViewsRead(
  rows: any[],
  client: SupabaseClient,
  requesterId: string | undefined
): Promise<any[]> {
  if (!requesterId) return [];
  if (rows.length === 0) return rows;
  const owners = await resolveStoryOwners(client, distinctStoryIds(rows));
  return rows.filter((row) => owners.get(row?.story_id) === requesterId);
}

/**
 * GET stories: non-owner viewers keep the story content but must not receive
 * view analytics (views count + viewed_by ids) on other people's Stories.
 * The owner's own rows keep the fields (owner analytics).
 */
export function restrictStoryRowsRead(rows: any[], requesterId: string | undefined): any[] {
  if (!requesterId) return rows;
  return rows.map((row: any) => {
    if (!row || typeof row.user_id !== 'string' || row.user_id === requesterId) return row;
    const redacted: Record<string, unknown> = { ...row };
    for (const field of STORY_ANALYTIC_FIELDS) delete redacted[field];
    return redacted;
  });
}

/**
 * Story owner cannot create a reaction on their own Story (do.md section 2 /
 * Scenario F). Returns a denial message when the authenticated caller owns the
 * Story, otherwise null. If the Story cannot be resolved on the configured
 * projects the write is left to the database to accept or reject.
 */
export async function evaluateStoryReactionCreate(
  storyId: unknown,
  storyClients: SupabaseClient[],
  requesterId: string | undefined
): Promise<string | null> {
  if (!requesterId) return 'You must be authenticated to react to a story';
  if (typeof storyId !== 'string' || storyId.length === 0) {
    return 'A valid story is required to react to';
  }
  for (const client of storyClients) {
    try {
      const { data, error } = await client
        .from('stories')
        .select('user_id')
        .eq('id', storyId)
        .maybeSingle();
      if (error || !data) continue;
      const owner = (data as { user_id?: string }).user_id;
      if (typeof owner !== 'string') continue;
      return owner === requesterId ? 'Story owners cannot react to their own story' : null;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Deny a story_reactions write (single row or array) when any target Story is
 * owned by the authenticated caller.
 */
export async function storyReactionWriteDenied(
  body: unknown,
  storyClients: SupabaseClient[],
  requesterId: string | undefined
): Promise<string | null> {
  const rows = Array.isArray(body)
    ? (body as Array<Record<string, unknown>>)
    : body && typeof body === 'object'
      ? [body as Record<string, unknown>]
      : [];
  for (const row of rows) {
    const denied = await evaluateStoryReactionCreate(row?.['story_id'], storyClients, requesterId);
    if (denied) return denied;
  }
  return null;
}

/**
 * A view counts even when the viewer never reacted, so the total comes from the
 * existing `story_views` tracking, never from reactions. After a viewer records
 * their view the gateway (service role) recounts `story_views` for the Story and
 * stores it on `stories.views` — no viewer-issued read of another user's view
 * rows or counts is ever required.
 */
export async function bumpStoryViewsCount(
  client: SupabaseClient | undefined,
  result: QueryResultRow | QueryResultRow[] | null
): Promise<void> {
  if (!client) return;
  const rows = Array.isArray(result) ? result : result ? [result] : [];
  for (const row of rows) {
    const storyId = row?.story_id;
    if (typeof storyId !== 'string') continue;
    try {
      const { count } = await client
        .from('story_views')
        .select('*', { count: 'exact', head: true })
        .eq('story_id', storyId);
      await client.from('stories').update({ views: count ?? 0 }).eq('id', storyId);
    } catch (error) {
      console.error('[storyPrivacy] Failed to bump story view count:', (error as Error).message);
    }
  }
}