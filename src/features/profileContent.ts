// Paginated, authorization-gated profile content for the SPA's one-item-at-a-time
// infinite scroll (do.md "Profile content pages").
//
// The generic `GET /:domain` read cannot serve this: it fans out over the
// readable projects for a domain, issues `select('*')` with no `order`, `limit`,
// `offset` or `range`, and merges every row it found. The SPA additionally never
// serialises those parameters, so a "one item per request" caller would still
// download the author's entire history on every page. This module therefore owns
// its own keyset read, exactly as `reactionUsers.ts` owns the paginated reaction
// list.
//
// Three properties are load-bearing and are the reason this is not just
// "getUserPosts(offset)":
//
//  1. CURSOR, NOT OFFSET. The cursor is the `(created_at, id)` of the last item
//     RETURNED, and the SQL predicate is a strict keyset
//     `(created_at, id) < (cursor.created_at, cursor.id)`. A post inserted at
//     the head while the viewer scrolls cannot shift the window, so nothing is
//     duplicated or skipped. `created_at` alone is not enough: it has
//     sub-second precision here but ties are routine in older rows, so `id`
//     breaks them and makes the order a TOTAL order (a tie with an unstable
//     tie-break is the classic source of both duplicate and dropped rows).
//
//  2. UNAUTHORIZED ROWS ARE SKIPPED, NOT REFUSED. The generic read and
//     `getReactionUsersPage` both reduce an already-materialised array. Paging
//     that way with `limit: 1` would let one Friends-only post at the head
//     starve the viewer forever, or (worse, if the cursor were then advanced
//     past it blindly) skip public content. Instead each round fetches a small
//     ordered batch, drops the rows this viewer may not read, returns the first
//     survivor, and — when a whole batch is unauthorized — advances the cursor
//     past the rejected rows and tries again. The cursor therefore always lands
//     on a row the client actually received.
//
//  3. THE AUTHORIZATION DECISION IS THE SHARED ONE. `canViewerViewPost` is the
//     same predicate the generic `posts` read uses, so a profile page, the home
//     feed, Explore and a direct `/post/:id` link can never disagree about who
//     may read a row. Nothing here re-implements the audience matrix.
//
// The `posts` read is service-role, so RLS is inert and this module (plus the
// route that wraps it) is the enforcement boundary. The SPA still applies its own
// audience filter as defense-in-depth; that is unchanged by this endpoint.

import { canViewerViewPost, type ReactionProject, type ReactionClient, type ReactionRow } from './reactionUsers';
import { filterScheduledPosts } from './scheduledPostPrivacy';

export type ProfileContentKind = 'posts' | 'photos' | 'reels' | 'shared';

export const PROFILE_CONTENT_KINDS: readonly ProfileContentKind[] = ['posts', 'photos', 'reels', 'shared'];

/** The public profile projection the SPA's post cards render. Never the row. */
export interface ProfileContentAuthor {
  username: string;
  display_name: string;
  profile_pic: string | null;
}

export interface ProfileContentSharedPost {
  id: string;
  content: string | null;
  media_url: string | null;
  media_type: string | null;
  type: string | null;
  created_at: string | null;
  profiles: ProfileContentAuthor;
}

export interface ProfileContentItem extends ReactionRow {
  profiles: ProfileContentAuthor;
  shared_post: ProfileContentSharedPost | null;
}

export interface ProfileContentPage {
  items: ProfileContentItem[];
  /** A row newer than the cursor may still exist. `false` ends the feed. */
  has_more: boolean;
  /** Opaque; feed back as `cursor` to get the following page. */
  next_cursor: string | null;
  /** The kind actually served, echoed so a client cannot mis-attribute a page. */
  kind: ProfileContentKind;
  /** Rows examined but withheld, across every round. Diagnostics only. */
  withheld_count: number;
}

export interface ProfileContentDeps {
  posts: ReactionProject[];
  friends: ReactionProject[];
  profiles: ReactionProject[];
}

/**
 * Rows read per shard per round. Must be comfortably larger than `limit` so a
 * page can be answered with a full lookahead, and large enough that a short run
 * of unauthorized rows does not cost a round-trip.
 */
const SCAN_BATCH = 12;

/**
 * Upper bound on skip-and-advance rounds for a single request. A profile whose
 * newest rows are all private to somebody else (a long scheduled run, say)
 * would otherwise be walked in one unbounded request. When the bound is hit the
 * page is returned empty with `has_more: true` and an advanced cursor, so the
 * caller makes progress across requests instead of stalling or over-fetching.
 */
const MAX_SKIP_ROUNDS = 8;

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 1;

// --- small row helpers (kept local so reactionUsers' surface is untouched) ---

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

async function queryRows(
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

// --- ordering ---------------------------------------------------------------

/**
 * Newest first. Returns > 0 when `a` is strictly older than `b`, so the caller
 * can both sort with it and ask "is this row past the last item I returned?".
 * `created_at` is the primary key of the order; `id` is the tie-break, which is
 * what makes the ordering total and therefore the cursor unambiguous.
 */
function compareNewestFirst(a: ReactionRow, b: ReactionRow): number {
  const ta = str(a, 'created_at') || '';
  const tb = str(b, 'created_at') || '';
  if (ta !== tb) return ta < tb ? 1 : -1;
  const ia = str(a, 'id') || '';
  const ib = str(b, 'id') || '';
  if (ia === ib) return 0;
  return ia < ib ? 1 : -1;
}

// --- cursor -----------------------------------------------------------------

interface ProfileContentCursor {
  created_at: string;
  id: string;
}

/**
 * Opaque keyset cursor. Base64url keeps `created_at`'s `:`/`+` characters out of
 * the query string, where a `+` would otherwise decode to a space.
 */
function encodeCursor(row: ReactionRow): string | null {
  const createdAt = str(row, 'created_at');
  const id = str(row, 'id');
  if (!createdAt || !id) return null;
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

/** A malformed cursor is treated as "start from the top", never as an error. */
export function decodeProfileContentCursor(value: unknown): ProfileContentCursor | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf('|');
  if (separator <= 0 || separator === decoded.length - 1) return null;
  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  // A cursor is only trusted if it could have come from a `posts` row.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) return null;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  return { created_at: createdAt, id };
}

// --- per-kind row predicate -------------------------------------------------

/**
 * The four Profile sections are four views of the one `posts` table, and these
 * predicates must not NARROW what the SPA's own section filters accept, or a
 * section would silently lose rows it shows today.
 *
 * Where the SPA's rule is a pure column test the predicate is copied exactly.
 * The Photos section is not: `extractPhotoAlbums` treats any non-video
 * `media_url` on a non-reel/non-chrome post as a photo, and most rows in the
 * live dataset carry `media_type = null` with an image URL — a
 * `media_type = 'image'` predicate would have dropped 10 of the 12 tiles the
 * Photos tab renders today. So this predicate is deliberately INCLUSIVE: it
 * excludes only the post types the SPA excludes, and leaves the video /
 * file-extension narrowing to `extractPhotoAlbums`, which still runs on the
 * client. Over-including costs one wasted item slot; under-including silently
 * deletes photos, which is far worse.
 */
function applyKindPredicate(query: any, kind: ProfileContentKind): any {
  switch (kind) {
    case 'photos':
      // Mirrors NON_PHOTO_POST_TYPES in the SPA's lib/profilePhotos.ts.
      //
      // The exclusions are ANDed INSIDE a disjunction, not ORed with each other:
      // `or=(type.is.null,type.neq.reel,type.neq.shared_post,...)` reads as
      // "the type is null, or it is not a reel, or it is not a share, ...", which
      // every row except one satisfies and therefore excludes nothing. The shape
      // that actually expresses "not one of the excluded types, and a NULL type
      // is not one of them either" is a single `or` with one NULL branch and one
      // `and` of the negations.
      return query
        .not('media_url', 'is', null)
        .or(
          'type.is.null,and(type.neq.reel,type.neq.shared_post,type.neq.profile_picture_update,type.neq.cover_photo_update)'
        );
    case 'reels':
      return query.eq('type', 'reel').not('media_url', 'is', null);
    case 'shared':
      // The SPA's rule was `type === 'shared_post' || shared_post_id`.
      return query.or('type.eq.shared_post,shared_post_id.not.is.null');
    case 'posts':
    default:
      return query;
  }
}

// --- the read ---------------------------------------------------------------

interface ReadRound {
  rows: ReactionRow[];
  /** True when some shard returned a full batch and therefore may hold more. */
  capped: boolean;
}

/**
 * One ordered batch per shard, all sharing the same keyset predicate, merged and
 * re-sorted globally.
 *
 * The same predicate must go to every shard and the merge must be re-sorted: the
 * per-shard merge-then-truncate that `getReactionUsersPage` uses is only correct
 * with a single active project, because each shard's page N is cut to `limit`
 * after merging and the union of those cuts is not the global page N.
 */
async function readRound(
  deps: ProfileContentDeps,
  profileId: string,
  kind: ProfileContentKind,
  cursor: ProfileContentCursor | null
): Promise<ReadRound> {
  const chunks = await Promise.all(
    deps.posts.map((project) =>
      queryRows(project.client, 'posts', (query) => {
        let next = query.select('*').eq('user_id', profileId);
        next = applyKindPredicate(next, kind);
        if (cursor) {
          // Strict keyset on the (created_at, id) total order:
          //   (created_at, id) < (cursor.created_at, cursor.id)
          next = next.or(
            `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
          );
        }
        return next.order('created_at', { ascending: false }).limit(SCAN_BATCH);
      })
    )
  );

  const byId = new Map<string, ReactionRow>();
  for (const row of chunks.flat()) {
    const id = str(row, 'id');
    if (!id || byId.has(id)) continue;
    byId.set(id, row);
  }

  return {
    rows: [...byId.values()].sort(compareNewestFirst),
    capped: chunks.some((rows) => rows.length >= SCAN_BATCH),
  };
}

// --- enrichment -------------------------------------------------------------

function toAuthor(row: ReactionRow | null | undefined): ProfileContentAuthor {
  return {
    username: str(row, 'username') || 'unknown',
    display_name: str(row, 'display_name') || 'Unknown user',
    profile_pic: str(row, 'profile_pic'),
  };
}

async function readAuthors(deps: ProfileContentDeps, ids: string[]): Promise<Map<string, ReactionRow>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const found = new Map<string, ReactionRow>();
  if (unique.length === 0) return found;
  await Promise.all(
    deps.profiles.map(async (project) => {
      const rows = await queryRows(project.client, 'profiles', (query) =>
        query.select('id, username, display_name, profile_pic').in('id', unique)
      );
      for (const row of rows) {
        const id = str(row, 'id');
        if (id && !found.has(id)) found.set(id, row);
      }
    })
  );
  return found;
}

/**
 * A `shared` item is a pointer to another author's post, and the card renders
 * that post's author. Resolving it here keeps the client from having to fetch the
 * shared post (and then its author) per item — and, more importantly, keeps the
 * decision about which shared post a viewer may see in the Gateway rather than in
 * React. The shared post is authorized with the SAME predicate as a top-level
 * post, so a Friends-only post cannot be exposed by being shared.
 */
async function enrichSharedPosts(
  deps: ProfileContentDeps,
  items: ProfileContentItem[],
  viewerId: string | undefined,
  friendIds: Set<string>
): Promise<void> {
  const targets = items
    .map((item) => ({ item, id: str(item, 'shared_post_id') }))
    .filter((entry): entry is { item: ProfileContentItem; id: string } => entry.id !== null);
  if (targets.length === 0) return;

  const found = new Map<string, ReactionRow>();
  await Promise.all(
    deps.posts.map(async (project) => {
      const rows = await queryRows(project.client, 'posts', (query) =>
        query.select('*').in('id', targets.map((entry) => entry.id))
      );
      for (const row of rows) {
        const id = str(row, 'id');
        if (id && !found.has(id)) found.set(id, row);
      }
    })
  );

  const authorIds = new Set<string>([viewerId].filter((id): id is string => typeof id === 'string'));
  for (const { id } of targets) {
    const owner = str(found.get(id), 'user_id');
    if (owner) authorIds.add(owner);
  }
  const authors = await readAuthors(deps, [...authorIds]);

  for (const { item, id } of targets) {
    const shared = found.get(id);
    // An unauthorized shared post is withheld exactly like a top-level one.
    if (!shared || !canViewerViewPost(shared, viewerId, friendIds)) continue;
    const owner = str(shared, 'user_id');
    item.shared_post = {
      id: str(shared, 'id') || id,
      content: (shared['content'] as string | null) ?? null,
      media_url: (shared['media_url'] as string | null) ?? null,
      media_type: (shared['media_type'] as string | null) ?? null,
      type: (shared['type'] as string | null) ?? null,
      created_at: str(shared, 'created_at'),
      profiles: toAuthor(owner ? authors.get(owner) : null),
    };
  }
}

/**
 * Authorize `rows` for this viewer.
 *
 * `canViewerViewPost` already encodes the owner bypass, the guest rule and the
 * fail-closed default for an unrecognised audience. `filterScheduledPosts` is
 * then applied for the same reason the generic read applies it: an author keeps
 * seeing their own scheduled rows (they have a dedicated Profile tab) while
 * nobody else ever receives one. Applying the two in this order reproduces the
 * generic read's result exactly.
 */
function authorizedRows(
  rows: ReactionRow[],
  viewerId: string | undefined,
  friendIds: Set<string>
): ReactionRow[] {
  return filterScheduledPosts(
    rows.filter((row) => canViewerViewPost(row, viewerId, friendIds)),
    viewerId
  ) as ReactionRow[];
}

export function parseProfileContentKind(value: unknown): ProfileContentKind | null {
  return typeof value === 'string' && (PROFILE_CONTENT_KINDS as readonly string[]).includes(value)
    ? (value as ProfileContentKind)
    : null;
}

export function clampProfileContentLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed)));
}

/**
 * The next page of a profile's content, as a cursor/keyset read.
 *
 * `limit` defaults to 1: the SPA asks for exactly one item per scroll, so a
 * request never transfers more content than the user is about to see.
 */
export async function getProfileContentPage(
  deps: ProfileContentDeps,
  profileId: string,
  viewerId: string | undefined,
  friendIds: Set<string>,
  kind: ProfileContentKind,
  options: { limit?: unknown; cursor?: unknown } = {}
): Promise<ProfileContentPage> {
  const limit = clampProfileContentLimit(options.limit);
  let cursor = decodeProfileContentCursor(options.cursor);
  let withheld = 0;
  let rounds = 0;

  for (;;) {
    const round = await readRound(deps, profileId, kind, cursor);
    rounds += 1;

    if (round.rows.length === 0) {
      // The shard(s) hold nothing older than the cursor: the feed is finished.
      return { items: [], has_more: false, next_cursor: null, kind, withheld_count: withheld };
    }

    const authorized = authorizedRows(round.rows, viewerId, friendIds);
    withheld += round.rows.length - authorized.length;

    if (authorized.length > 0) {
      const items = authorized.slice(0, limit) as ProfileContentItem[];
      const last = items[items.length - 1];
      const next = encodeCursor(last);
      if (!next) {
        // A row with no id/created_at cannot be used as a cursor, so serving it
        // would make the next page repeat it forever.
        return { items: [], has_more: false, next_cursor: null, kind, withheld_count: withheld };
      }
      // More content exists if a row older than the last item was already in
      // hand, or if a shard was capped (and so may hold rows we never saw).
      const olderInHand = round.rows.some((row) => compareNewestFirst(row, last) > 0);
      const hasMore = olderInHand || round.capped;
      const authors = await readAuthors(deps, [
        profileId,
        ...items.map((item) => str(item, 'user_id')).filter((id): id is string => id !== null),
      ]);
      for (const item of items) {
        const owner = str(item, 'user_id');
        item.profiles = toAuthor(owner ? authors.get(owner) : null);
        item.shared_post = null;
      }
      await enrichSharedPosts(deps, items, viewerId, friendIds);
      return { items, has_more: hasMore, next_cursor: next, kind, withheld_count: withheld };
    }

    if (rounds >= MAX_SKIP_ROUNDS) {
      // Everything in reach was unauthorized. Hand back an advanced cursor with
      // `has_more: true` so the caller can continue on its next request rather
      // than being told the profile ended here.
      const advanced = encodeCursor(round.rows[round.rows.length - 1]);
      if (!advanced) return { items: [], has_more: false, next_cursor: null, kind, withheld_count: withheld };
      return { items: [], has_more: true, next_cursor: advanced, kind, withheld_count: withheld };
    }

    // Whole batch withheld: step the cursor past the rejected rows so the next
    // round examines strictly older content. This is what keeps a private post
    // at the head from starving a guest, and what lets the guest go on to the
    // public post after it.
    const advanced = encodeCursor(round.rows[round.rows.length - 1]);
    if (!advanced) return { items: [], has_more: false, next_cursor: null, kind, withheld_count: withheld };
    cursor = decodeProfileContentCursor(advanced);
  }
}
