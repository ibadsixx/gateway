// Page-post author attribution (do.md "Page Posts Must Display the Page Name,
// Not the Owner's Personal Name").
//
// There is no page column on `posts`. A post published "as a Page" is stored as
// an ordinary `posts` row authored by the page admin's PERSONAL user id, plus a
// `page_posts(page_id, post_id, shared_by)` link. The Page's own feed already
// renders the Page (the SPA adapter stamps the page identity onto each item),
// but every OTHER surface — the home feed, a direct `/post/:id` link, Explore,
// Saved, Hashtag, Group and search — reads through the generic `GET /posts` /
// `GET /posts/:id` routes, which had no way to learn that the row belongs to a
// Page. Those surfaces therefore resolved the author from `profiles` by
// `user_id` and showed the admin's personal name and avatar.
//
// This module resolves the owning Page for a set of post rows and attaches it
// to each row as a `page` object, so the SPA's shared `Post` card can render the
// Page's name and image as the author.
//
// The attribution is derived ONLY from the stable `page_posts` association
// (page_id -> post_id) joined to the `pages` row by that page id. It is never
// inferred from a display name, a username, an image URL, or the author's own
// identity — a Page and a user are different entities and only the existing link
// table relates them.
//
// The authenticated user remains the row's `user_id` (auth / audit / ownership
// are unchanged); this only ADDS the display identity.

import type { ReactionClient, ReactionProject, ReactionRow } from './reactionUsers';

/** The public Page projection the shared post card renders. */
export interface PageIdentity {
  id: string;
  name: string;
  cover_image: string | null;
  profile_pic: string | null;
}

/** Default page-image fallback: `profile_pic` first, then `cover_image`. */
function str(row: ReactionRow | null | undefined, key: string): string | null {
  if (!row) return null;
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rowsFrom(result: any): ReactionRow[] {
  if (!result || result.error) return [];
  return Array.isArray(result.data)
    ? result.data.filter((row: unknown): row is ReactionRow => !!row && typeof row === 'object')
    : [];
}

async function safeRows(
  client: ReactionClient,
  table: string,
  build: (query: any) => any
): Promise<ReactionRow[]> {
  try {
    return rowsFrom(await build(client.from(table)));
  } catch {
    // A domain is sharded across projects that do not all carry every table.
    return [];
  }
}

/** Map of post id -> page id, from the `page_posts` link table. */
export async function readPostPageLinks(
  pagePostProjects: ReactionProject[],
  postIds: string[]
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const ids = [...new Set(postIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (pagePostProjects.length === 0 || ids.length === 0) return links;
  await Promise.all(
    pagePostProjects.map(async (project) => {
      const rows = await safeRows(project.client, 'page_posts', (query) =>
        query.select('page_id, post_id').in('post_id', ids)
      );
      for (const row of rows) {
        const postId = str(row, 'post_id');
        const pageId = str(row, 'page_id');
        // First writer wins; a post is linked to at most one page by the
        // existing creation path, so this is deterministic in practice.
        if (postId && pageId && !links.has(postId)) links.set(postId, pageId);
      }
    })
  );
  return links;
}

/** Map of page id -> Page identity, from the `pages` table. */
export async function readPageIdentities(
  pageProjects: ReactionProject[],
  pageIds: string[]
): Promise<Map<string, PageIdentity>> {
  const pages = new Map<string, PageIdentity>();
  const ids = [...new Set(pageIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (pageProjects.length === 0 || ids.length === 0) return pages;
  await Promise.all(
    pageProjects.map(async (project) => {
      const rows = await safeRows(project.client, 'pages', (query) =>
        query.select('id, name, cover_image, profile_pic').in('id', ids)
      );
      for (const row of rows) {
        const id = str(row, 'id');
        if (!id || pages.has(id)) continue;
        pages.set(id, {
          id,
          name: str(row, 'name') ?? 'Page',
          cover_image: str(row, 'cover_image'),
          profile_pic: str(row, 'profile_pic'),
        });
      }
    })
  );
  return pages;
}

export interface AttachPageIdentityDeps {
  /** The `page_posts` domain projects (its own domain, not part of `pages`). */
  pagePosts: ReactionProject[];
  /** The `pages` domain projects. */
  pages: ReactionProject[];
}

/**
 * Attach the owning Page to every page-linked post row.
 *
 * Returns new row objects; the input rows are never mutated in place. A row
 * that is not linked to any page is returned unchanged (as the same reference),
 * so personal posts are entirely untouched and the response volume is not
 * inflated for them. If the `page_posts` or `pages` read yields nothing, every
 * row is returned unchanged — the attribution is additive and fail-open.
 */
export async function attachPageIdentity(
  rows: ReactionRow[],
  deps: AttachPageIdentityDeps
): Promise<ReactionRow[]> {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const postIds = rows
    .map((row) => str(row, 'id'))
    .filter((id): id is string => id !== null);
  if (postIds.length === 0) return rows;

  // A share embeds the original post under `shared_post`; it too can be a page
  // post, so resolve page links for the embedded ids in the same pass.
  const sharedIds = rows
    .map((row) => {
      const shared = row['shared_post'];
      return shared && typeof shared === 'object' ? str(shared as ReactionRow, 'id') : null;
    })
    .filter((id): id is string => id !== null);

  const links = await readPostPageLinks(deps.pagePosts, [...postIds, ...sharedIds]);
  if (links.size === 0) return rows;
  const pages = await readPageIdentities(deps.pages, [...links.values()]);
  if (pages.size === 0) return rows;

  const pageFor = (id: string | null): PageIdentity | null => {
    if (!id) return null;
    const pageId = links.get(id);
    return pageId ? pages.get(pageId) ?? null : null;
  };

  return rows.map((row) => {
    const postId = str(row, 'id');
    const page = pageFor(postId);
    const shared = row['shared_post'];
    const sharedPage =
      shared && typeof shared === 'object' ? pageFor(str(shared as ReactionRow, 'id')) : null;

    // Nothing to add for this row (and no share to annotate): keep the reference
    // so personal posts and their response volume are entirely untouched.
    if (!page && !sharedPage) return row;

    const next: ReactionRow = { ...row };
    if (page) next['page'] = page;
    if (sharedPage && shared && typeof shared === 'object') {
      next['shared_post'] = { ...(shared as ReactionRow), page: sharedPage };
    }
    return next;
  });
}
