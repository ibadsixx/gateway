// Scheduled posts are strictly private to their author (pro.md - "Scheduled").
//
// The generic /:domain read routes query with a service-role client, which
// bypasses Supabase RLS. Without a requester-aware filter, ANY authenticated
// user's `/api/posts` response would include every user's `status='scheduled'`
// rows. Nothing else in the ecosystem legitimately reads another user's
// scheduled posts (verified: only the owner's Scheduled tab reads
// status='scheduled'), so dropping them for non-owners cannot regress real
// features. These helpers are the shared boundary that enforces the privacy
// rule over the wire; the UI additionally hides the tab for non-owners.

export const SCHEDULED_POST_STATUS = 'scheduled';

export function isScheduledPost(row: unknown): boolean {
  return Boolean(
    row &&
      typeof row === 'object' &&
      (row as Record<string, unknown>).status === SCHEDULED_POST_STATUS,
  );
}

// Removes scheduled posts that do not belong to the requester. An absent
// requester (defense in depth) never sees any scheduled post.
export function filterScheduledPosts(
  rows: unknown[],
  requesterId: string | undefined,
): unknown[] {
  return rows.filter((row) => {
    if (!isScheduledPost(row)) return true;
    if (!requesterId) return false;
    return (row as Record<string, unknown>).user_id === requesterId;
  });
}

// True when a single-row read resolves to a scheduled post another user owns.
// Such reads are treated as not found so a single-row GET cannot leak one.
export function isForeignScheduledPost(
  row: unknown,
  requesterId: string | undefined,
): boolean {
  if (!isScheduledPost(row)) return false;
  if (!requesterId) return true;
  return (row as Record<string, unknown>).user_id !== requesterId;
}