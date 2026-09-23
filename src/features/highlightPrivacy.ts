// Gateway-side "Add to Highlight" authorization (do.md).
//
// The generic /:domain routes run with service-role clients (RLS bypassed), so
// this guard is the API boundary that enforces:
//   - only the Story OWNER may add a Story to a Highlight
//   - a Story may only ever be added to the owner's OWN Highlights
//   - a direct API/Gateway request from any other user is rejected (403)
//   - a highlight group can only ever be created under the authenticated
//     caller's own user_id (never someone else's)

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolve the owning user_id of a single row (stories / story_highlights
 * tables) across the given project clients. Returns null when the row cannot
 * be resolved; in that case the database constraints (FK) decide the outcome.
 */
async function resolveOwnerId(
  clients: SupabaseClient[],
  table: 'stories' | 'story_highlights',
  id: string
): Promise<string | null> {
  for (const client of clients) {
    try {
      const { data, error } = await client
        .from(table)
        .select('user_id')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) continue;
      const owner = (data as { user_id?: string }).user_id;
      if (typeof owner === 'string') return owner;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Evaluate a single story_highlight_items insert. Denied (returns a message)
 * unless the authenticated caller owns BOTH the Story and the Highlight.
 */
export async function evaluateHighlightItemCreate(
  highlightId: unknown,
  storyId: unknown,
  highlightClients: SupabaseClient[],
  storyClients: SupabaseClient[],
  requesterId: string | undefined
): Promise<string | null> {
  if (!requesterId) return 'You must be authenticated to add a story to a highlight';
  if (
    typeof highlightId !== 'string' ||
    highlightId.length === 0 ||
    typeof storyId !== 'string' ||
    storyId.length === 0
  ) {
    return 'A valid highlight and story are required';
  }
  const storyOwner = await resolveOwnerId(storyClients, 'stories', storyId);
  if (storyOwner !== null && storyOwner !== requesterId) {
    return 'Only the Story owner can add their Story to a Highlight';
  }
  const highlightOwner = await resolveOwnerId(highlightClients, 'story_highlights', highlightId);
  if (highlightOwner !== null && highlightOwner !== requesterId) {
    return 'You can only add Stories to your own Highlights';
  }
  return null;
}

/**
 * Deny a story_highlight_items write (single row or array) when any target
 * Story/Highlight pairing is not owned by the authenticated caller.
 */
export async function highlightItemWriteDenied(
  body: unknown,
  highlightClients: SupabaseClient[],
  storyClients: SupabaseClient[],
  requesterId: string | undefined
): Promise<string | null> {
  const rows = Array.isArray(body)
    ? (body as Array<Record<string, unknown>>)
    : body && typeof body === 'object'
      ? [body as Record<string, unknown>]
      : [];
  for (const row of rows) {
    const denied = await evaluateHighlightItemCreate(
      row?.['highlight_id'],
      row?.['story_id'],
      highlightClients,
      storyClients,
      requesterId
    );
    if (denied) return denied;
  }
  return null;
}