// Audience authorization for post-shaped content (posts, reels, photos).
//
// do.md "Friends audience": the Gateway's generic `GET /:domain` and
// `GET /:domain/:id` routes read with a service-role client, which BYPASSES
// Supabase RLS. That made the `Posts are viewable based on audience and status`
// policy inert for every request the SPA makes, so a `friends` / `only_me` post
// was serialized to any authenticated caller (and, on the surfaces with no
// client-side filter, its media URL was fetched and cached too). The React
// fallback in the SPA is defense-in-depth only; enforcement happens here.
//
// Rules implemented by this module (the single evaluator, shared with the
// reaction-user endpoints via `canViewerViewPost`):
//   - public   -> everyone, including guests
//   - friends  -> the owner and the owner's ACCEPTED friends only
//   - only_me  -> the owner only
//   - friends_except / specific / custom_list keep their existing semantics
// The viewer identity is always the authenticated Gateway session id
// (`req.user.id`); no client-supplied id is ever read, and a guest (no
// `req.user`) is never treated as a friend.
import { canViewerViewPost, getAcceptedFriendIds, type ReactionProject } from './reactionUsers';

export type ContentRow = Record<string, unknown>;

// Accepted-friendship set for the authenticated viewer, resolved ONCE per
// request (not per row) from the friends project(s). A read error yields an
// empty set, which can only ever deny `friends` content — the safe direction.
export async function resolveViewerFriendIds(
  viewerId: string | undefined,
  friendsProjects: ReactionProject[]
): Promise<Set<string>> {
  if (!viewerId) return new Set();
  return getAcceptedFriendIds(friendsProjects, viewerId);
}

// Reduces a `posts` response to the rows this viewer is authorized to see.
// Applied to every `posts` read, whatever surface asked for it, so friends-only
// content can never leak through the home feed, a profile, Explore, search,
// hashtags, reels, photos, saved posts or a direct `/post/:id` link.
export function filterContentRowsForViewer<T extends ContentRow>(
  rows: T[],
  viewerId: string | undefined,
  friendIds: Set<string>
): T[] {
  return rows.filter((row) => canViewerViewPost(row, viewerId, friendIds));
}

// True when this single row may be returned to the viewer. Used by the
// single-row GET routes, which answer 404 rather than 403 so the response
// does not confirm that a private post exists.
export function canViewerReadContentRow(
  row: ContentRow | null | undefined,
  viewerId: string | undefined,
  friendIds: Set<string>
): boolean {
  return canViewerViewPost(row, viewerId, friendIds);
}
