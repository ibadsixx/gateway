// Gateway-side authorization for `page_posts` (do.md "Fix Page Posts Not
// Appearing on Their Own Page").
//
// The generic `POST /:domain` route writes with a service-role client, so it
// BYPASSES Supabase RLS (`page_posts_insert_admin`). Without a guard here any
// authenticated caller could associate any post with any page — publishing a
// post "as a page" they do not manage. This module is the API boundary that
// mirrors that insert policy exactly:
//   - the caller must be authenticated
//   - the caller must be the page's `admin_id`
//   - `shared_by` is stamped to the authenticated caller, never a body value
//
// The frontend's shared post-creation path (useHomeFeed.createPost) writes the
// `page_posts` row whenever a post is published while acting as a page, so this
// guard is what keeps that safe.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolve the owning `admin_id` of a page across the given project clients.
 * Returns null when the page cannot be resolved; the FK constraint then decides
 * the outcome (same convention as the other write guards).
 */
async function resolvePageAdminId(
  clients: SupabaseClient[],
  pageId: string
): Promise<string | null> {
  for (const client of clients) {
    try {
      const { data, error } = await client
        .from('pages')
        .select('admin_id')
        .eq('id', pageId)
        .maybeSingle();
      if (error || !data) continue;
      const adminId = (data as { admin_id?: unknown }).admin_id;
      if (typeof adminId === 'string' && adminId.length > 0) return adminId;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Evaluate a single `page_posts` insert. Denied (returns a message) unless the
 * authenticated caller administers the target page.
 */
export async function evaluatePagePostCreate(
  pageId: unknown,
  sharedBy: unknown,
  pageClients: SupabaseClient[],
  requesterId: string | undefined
): Promise<string | null> {
  if (!requesterId) return 'You must be authenticated to publish a post for a page';
  if (typeof pageId !== 'string' || pageId.length === 0) {
    return 'A valid page is required';
  }
  if (sharedBy !== undefined && sharedBy !== null && sharedBy !== requesterId) {
    return 'A page post can only be attributed to the authenticated user';
  }
  const adminId = await resolvePageAdminId(pageClients, pageId);
  if (adminId !== null && adminId !== requesterId) {
    return 'You can only publish posts for pages you manage';
  }
  return null;
}

/**
 * Deny a `page_posts` write (single row or array) when any row targets a page
 * the authenticated caller does not administer.
 */
export async function pagePostWriteDenied(
  body: unknown,
  pageClients: SupabaseClient[],
  requesterId: string | undefined
): Promise<string | null> {
  const rows = Array.isArray(body)
    ? (body as Array<Record<string, unknown>>)
    : body && typeof body === 'object'
      ? [body as Record<string, unknown>]
      : [];
  for (const row of rows) {
    const denied = await evaluatePagePostCreate(row?.['page_id'], row?.['shared_by'], pageClients, requesterId);
    if (denied) return denied;
  }
  return null;
}

/**
 * Stamp `shared_by` on a `page_posts` insert payload (single row or array) so a
 * client can never attribute a page post to another user.
 */
export function stampPagePostSharedBy(body: unknown, requesterId: string | undefined): void {
  if (!requesterId || !body || typeof body !== 'object') return;
  const rows = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [body as Record<string, unknown>];
  for (const row of rows) {
    if (row && typeof row === 'object') row['shared_by'] = requesterId;
  }
}

/**
 * The post ids a `page_posts` write (single row or array) links to a page.
 * Used to enforce the page-post audience invariant after the link is stored.
 */
export function collectPagePostIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const rows = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [body as Record<string, unknown>];
  const ids: string[] = [];
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof row['post_id'] === 'string' && row['post_id']) {
      ids.push(row['post_id'] as string);
    }
  }
  return [...new Set(ids)];
}

/**
 * Enforce the page-post audience invariant after a `page_posts` link is stored.
 *
 * A post linked to a Page belongs to that Page, and a Page is public by design
 * (the Gateway serves `pages` and `page_posts` to guests). Persisting the
 * personal composer default (`friends`) on a page post made the Gateway's
 * audience enforcement hide it from every viewer but the admin, so the page
 * showed nothing. The shared creation path already sends `public`; this keeps
 * the invariant server-side for every writer of this route.
 *
 * Only the caller's OWN post is touched: the insert policy does not restrict the
 * linked post to the caller, so forcing someone else's post public would escalate
 * access. Anything whose `user_id` is not the caller is left as-is.
 *
 * Best-effort: the link is already stored, so a failed update is logged only.
 */
export async function publishLinkedPagePosts(
  sharedBy: string | undefined,
  postIds: string[],
  readPost: (id: string) => Promise<Record<string, unknown> | null>,
  updatePost: (id: string, patch: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (!sharedBy || postIds.length === 0) return;
  for (const postId of postIds) {
    try {
      const post = await readPost(postId);
      if (!post || post['user_id'] !== sharedBy) continue;
      if (post['audience_type'] === 'public') continue;
      await updatePost(postId, {
        audience_type: 'public',
        audience_user_ids: null,
        audience_excluded_user_ids: null,
        audience_list_id: null,
      });
    } catch (error) {
      console.warn(
        `[pagePosts] could not publish linked post ${postId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}
