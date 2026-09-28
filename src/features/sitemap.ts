// Public sitemap / sitemap index for crawlable content (do.md "Sitemap/discovery").
//
// The important property is that this is NOT a generated file. Nothing here is
// written to disk, cached, or precomputed, so it cannot go stale: every request
// re-reads the tables and re-evaluates each row's privacy rules through the one
// canonical predicate per section. That is what makes the required transitions
// fall out for free rather than needing invalidation (do.md §15):
//
//   public -> friends   the row stops matching the predicate, so it leaves the
//                       sitemap on the very next crawl
//   friends -> public   the row starts matching, so it becomes eligible
//   deleted             the row is gone from the table
//   private, never public
//                       the row never matches, so its ID is never read into a
//                       sitemap response at all
//
// That last point is why the filter is applied to the ROWS and not to a
// pre-built ID list: there is no code path in which a restricted content ID can
// reach the XML (do.md §14).
//
// Shape - chosen automatically, not configured (do.md §13 "do not create an
// unnecessarily complex index if the number of URLs is small"):
//
//   total pages == 1
//     GET /api/sitemap.xml   -> <urlset>  every public URL, all sections
//
//   total pages  > 1
//     GET /api/sitemap.xml   -> <sitemapindex> listing N <sitemap>
//     GET /api/sitemap-posts-1.xml    -> <urlset> newest 1000 post URLs
//     GET /api/sitemap-posts-2.xml    -> the next 1000, older
//     GET /api/sitemap-reels-1.xml    -> <urlset>
//     ...
//
// A crawler always follows whatever `/sitemap.xml` returns, so the promotion from
// a urlset to an index is invisible to it. The section-per-file split is not
// cosmetic: it is what stops one busy section from forcing the whole sitemap
// into a deep page walk, and it keeps each child inside Google's 50,000-URL and
// 50MB ceilings on its own.
import { isGuestSafePublicContent } from './contentAudience';
import { isSearchEngineIndexingEnabled } from './profileIndexing';
import type { AudienceRow } from './contentAudience';

export type SitemapRow = AudienceRow & {
  id?: unknown;
  type?: unknown;
  media_type?: unknown;
  created_at?: unknown;
  username?: unknown;
  privacy?: unknown;
  tag?: unknown;
  // Projected onto a profile row by the reader, which is the only place that
  // can see another table. Absent means "no stored preference", which is now the
  // indexable default - see isIndexableProfileRow.
  search_engine_indexing?: unknown;
};

// Backwards-compatible alias: the original name for "a row this module reads".
export type SitemapContentRow = SitemapRow;

// Google's hard ceiling is 50,000 URLs per sitemap file and 50MB uncompressed.
export const SITEMAP_PAGE_SIZE = 1000;
// Enough pages that the 50k/file ceiling is never the binding constraint, while
// still refusing to build an unbounded index if a count ever goes wrong.
export const SITEMAP_MAX_PAGES = 2000;

// ---------------------------------------------------------------------------
// Sections (do.md §3-§7)
// ---------------------------------------------------------------------------

export type SitemapSection =
  | 'posts'
  | 'reels'
  | 'photos'
  | 'profiles'
  | 'pages'
  | 'groups'
  | 'hashtags';

export const SITEMAP_SECTIONS: readonly SitemapSection[] = [
  'posts',
  'reels',
  'photos',
  'profiles',
  'pages',
  'groups',
  'hashtags',
] as const;

// do.md §8: "for each sitemap section, query only the data source that owns that
// content." Reels and photos are not separate tables - they are posts carrying a
// different `type`/`media_type` - so all three content sections read the posts
// project and are separated in memory.
export const SITEMAP_SECTION_DOMAIN: Record<SitemapSection, string> = {
  posts: 'posts',
  reels: 'posts',
  photos: 'posts',
  profiles: 'profiles',
  pages: 'pages',
  groups: 'groups',
  hashtags: 'hashtags',
};

export const SITEMAP_SECTION_TABLE: Record<SitemapSection, string> = {
  posts: 'posts',
  reels: 'posts',
  photos: 'posts',
  profiles: 'profiles',
  pages: 'pages',
  groups: 'groups',
  hashtags: 'hashtags',
};

// The frontend route each section is served at. MUST stay in sync with src/App.tsx
// (`/post/:id`, `/reel/:id`, `/photo/:id`, `/profile/:username`, `/pages/:id`,
// `/groups/:groupId`, `/hashtag/:tag`) - a URL in the sitemap that 404s spends
// crawl budget on nothing.
export const SITEMAP_SECTION_PATH_PREFIX: Record<SitemapSection, string> = {
  posts: '/post/',
  reels: '/reel/',
  photos: '/photo/',
  profiles: '/profile/',
  pages: '/pages/',
  groups: '/groups/',
  hashtags: '/hashtag/',
};

// Only the posts sections' path is derived from PUBLIC_CONTENT_PATH_PREFIX,
// because that is the constant the frontend's seo.ts asserts against.
export type PublicContentKind = 'post' | 'reel' | 'photo';

// MUST stay in sync with the SPA routes in src/App.tsx
// (`/post/:id`, `/reel/:id`, `/photo/:id`) and with `publicContentPath` in
// tone-your-social-voice/src/lib/seo.ts. Both repos assert the same three
// literals, so a rename on one side fails a test on the other rather than
// silently emitting dead sitemap URLs.
export const PUBLIC_CONTENT_PATH_PREFIX: Record<PublicContentKind, string> = {
  post: '/post/',
  reel: '/reel/',
  photo: '/photo/',
};

// A reel is a post whose stored `type` is exactly 'reel' (the same rule the app
// uses in src/lib/profileReels.ts - a plain video post is NOT a reel). A photo
// is a post carrying image media. Everything else is an ordinary post.
export function publicContentKind(row: SitemapRow): PublicContentKind {
  if (typeof row.type === 'string' && row.type.trim().toLowerCase() === 'reel') return 'reel';
  if (row.media_type === 'image') return 'photo';
  return 'post';
}

const CONTENT_SECTION_KIND: Partial<Record<SitemapSection, PublicContentKind>> = {
  posts: 'post',
  reels: 'reel',
  photos: 'photo',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A username or hashtag becomes a path segment verbatim, so it has to be a
// shape that cannot escape the prefix or break the XML. The app's own convention
// is the right one to copy rather than invent: mentions and hashtags are parsed
// as `@\w+` / `#\w+` in useMentions.ts and MentionHashtagText.tsx, and hashtag
// links are lowercased at render time. `\w` is [A-Za-z0-9_].
//
// A username that fails this is simply not listed. That is a discoverability
// miss on a pathological value, never a leak - the row is unreachable from the
// sitemap either way.
const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

export function publicContentPath(
  row: Pick<SitemapRow, 'id' | 'type' | 'media_type'>
): string | null {
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;
  // A post id is a uuid; a path segment built from anything else (an injected
  // `../`, a newline, a quote) could either escape the prefix or break out of
  // the XML attribute, so the sitemap only ever emits verified uuids.
  if (!UUID_RE.test(id)) return null;
  return `${PUBLIC_CONTENT_PATH_PREFIX[publicContentKind(row)]}${id.toLowerCase()}`;
}

function uuidPath(prefix: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!UUID_RE.test(id)) return null;
  return `${prefix}${id.toLowerCase()}`;
}

export function profileUsernamePath(username: unknown): string | null {
  if (typeof username !== 'string') return null;
  const name = username.trim();
  if (!NAME_RE.test(name)) return null;
  return `${SITEMAP_SECTION_PATH_PREFIX.profiles}${name}`;
}

export function hashtagPath(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const name = tag.trim();
  if (!NAME_RE.test(name)) return null;
  // Lowercased to match what the app itself links to (`/hashtag/${tag
  // .toLowerCase()}`), so the sitemap and an internal link are the same URL and
  // the same tag is never advertised under two spellings.
  return `${SITEMAP_SECTION_PATH_PREFIX.hashtags}${name.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Per-section privacy / indexability
// ---------------------------------------------------------------------------

// The posts RLS policy is a CASE whose fallthrough is `false`
// (migration 20250907142243, as rewritten by 20250913194929):
//
//     WHEN status = 'scheduled' THEN user_id = auth.uid()
//     WHEN status = 'published' THEN can_view_post(...)
//     WHEN status = 'draft'     THEN user_id = auth.uid()
//     ELSE false
//
// So an anonymous client can read a post row ONLY when `status` is exactly the
// lowercase literal 'published'. In particular `ELSE false` also denies
// `status IS NULL`, which the column permits: the column is
// `text DEFAULT 'published' CHECK (status IN ('published','scheduled','draft'))`
// and a CHECK constraint is satisfied by NULL, so an explicit NULL insert
// (which bypasses the DEFAULT) lands in the denied branch.
//
// `isGuestSafePublicContent` is deliberately more permissive here - it treats an
// absent status as published, for legacy rows that predate the column. The
// Gateway reads with service_role, which bypasses RLS, so that tolerance is
// invisible to a crawler: the sitemap would advertise a URL that an anonymous
// PostgREST read refuses. This gate closes that gap in the one direction that
// matters, fail-closed, and costs nothing real: a NULL-status row is unreadable
// by everyone but its author anyway, so listing it has no discoverability value
// and only reveals that the id exists.
//
// It is also a strict superset check, not a heuristic: the CHECK constraint
// rejects any casing but the three literals, so 'PUBLISHED' cannot be stored and
// the exact comparison cannot miss a legitimately published post.
function isAnonymousReadablePostStatus(status: unknown): boolean {
  return status === 'published';
}

// Posts, reels and photos. Layer 1 of 2 (the other is the query prefilter in
// ./sitemapSource): the same `isGuestSafePublicContent` that decides whether an
// anonymous caller may read the row, PLUS the RLS status gate above. The sitemap
// is strictly narrower than what a guest can already fetch from `GET /api/posts`,
// never wider (do.md §3-§5, §14).
function contentRowPath(section: SitemapSection, row: SitemapRow): string | null {
  const kind = CONTENT_SECTION_KIND[section];
  if (!kind) return null;
  if (!isGuestSafePublicContent(row)) return null;
  if (!isAnonymousReadablePostStatus(row.status)) return null;
  // A reel is not also a post. Without this, `publicContentKind` would happily
  // place a reel in /sitemap-posts-1.xml while the index also advertises
  // /sitemap-reels-1.xml, and a crawler would see the same id twice.
  if (publicContentKind(row) !== kind) return null;
  return publicContentPath(row);
}

// WHAT do.md's FIVE ELIGIBILITY CONDITIONS ACTUALLY MAP TO HERE, because four of
// the five are structural and only one is a per-user gate. Established by reading
// the schema, not assumed:
//
//   1. "the profile exists and is active"   -> row existence. STRUCTURAL: `profiles`
//      has NO is_active / status / deleted_at / is_deleted column. There is nothing
//      to test, and a row that came back from the query exists.
//   2. "publicly accessible to unauthenticated visitors" -> unconditional. STRUCTURAL:
//      the SELECT policy is `USING (NOT is_blocked(auth.uid(), id, 'full'))`, and for
//      an anonymous caller `auth.uid()` is NULL so no block row matches and EVERY
//      profile is guest-readable. Tone has no private/restricted profile state, so
//      this condition is currently vacuous rather than enforced. Recorded rather
//      than invented: adding a column to satisfy it would be a product change, not
//      a sitemap fix, and a sitemap that silently ignored the new column would be
//      worse than one that never had it.
//   3. "the search-engine setting allows it" -> the ONLY per-user gate. See below.
//   4. "not deleted, disabled, blocked from public access" -> physical only. STRUCTURAL:
//      deletion cascades (`profiles.id REFERENCES auth.users(id) ON DELETE CASCADE`),
//      so a deleted account's row is gone and the per-request regeneration drops the
//      URL with nothing to do. The `blocks` table does NOT belong here: a block is
//      per-viewer, and a guest who is not blocked still reads the profile, so
//      excluding blocked users would de-list profiles the public can open.
//   5. "a valid public username/URL" -> enforced, by `profileUsernamePath` below.
//
// THE TRAP FOR A LATER CHANGE, stated here because nothing else will say it:
// conditions 1, 2 and 4 hold because the columns do not exist. If anyone later adds
// soft deletion (`deleted_at`), a `status`, or a profile-level private flag, this
// predicate will keep advertising those profiles - it reads only the search-engine
// setting, and a new column is invisible to it. Nothing will fail: there is no test
// that can fail, because the state is not expressible today. Whoever adds that column
// must extend `isIndexableProfileRow` and `PROFILES_SELECT` in the same change, or the
// sitemap will start publishing profiles the product considers gone.
//
// do.md §6. `privacy_settings` is a key/value table, and the setting is
// DEFAULT-ON as of the Sep 28, 2026 correction: a profile with no stored
// preference is in the sitemap, and only an explicit 'false' withholds it.
//
// This reverses the previous reading, which required an opt-in. The reversal is
// driven from the one predicate in ./profileIndexing rather than restated here,
// and the important consequence is recorded rather than left implicit: an
// EXPLICIT 'false' is what removes a profile, and because the opt-out query in
// sitemapSource is an equality filter on that literal, a user who has never
// opened the privacy checkup is advertised. That is the intended product
// behaviour, not an oversight, and the withdrawal path is the same one row.
export function isIndexableProfileRow(row: SitemapRow): boolean {
  if (!row || typeof row !== 'object') return false;
  // The SAME predicate the public profile page uses, imported rather than
  // repeated. These two surfaces answer one question about one user, and do.md is
  // explicit that a profile must be consistently in or out: if the page said
  // "index me" while the sitemap said "do not list me", Google would be told to
  // crawl a URL the sitemap had just stopped advertising. A duplicated literal
  // here is how that disagreement starts - one side gets a tolerance the other
  // does not, and the drift is invisible until a profile is published.
  if (!isSearchEngineIndexingEnabled(row.search_engine_indexing)) return false;
  return profileUsernamePath(row.username) !== null;
}

// do.md §7. Groups are the one non-content entity with per-row privacy, and the
// rule is the same literal the Gateway's own guest gate uses
// (`isGuestGroupVisible`: `privacy === 'public'`). Reusing the same literal keeps
// "a guest can open this group" and "this group is in the sitemap" from drifting.
export function isIndexableGroupRow(row: SitemapRow): boolean {
  if (!row || typeof row !== 'object') return false;
  if (row.privacy !== 'public') return false;
  return uuidPath(SITEMAP_SECTION_PATH_PREFIX.groups, row.id) !== null;
}

// The per-section path builder: privacy AND addressability in one place, so
// there is exactly one way a row can become a URL and exactly one way it cannot.
export function sitemapRowPath(section: SitemapSection, row: SitemapRow): string | null {
  if (!row || typeof row !== 'object') return null;
  switch (section) {
    case 'posts':
    case 'reels':
    case 'photos':
      return contentRowPath(section, row);
    case 'profiles':
      return isIndexableProfileRow(row) ? profileUsernamePath(row.username) : null;
    case 'pages':
      // do.md §7: pages carry no privacy column and are guest-readable by
      // design, so there is nothing to gate on beyond "has an id".
      return uuidPath(SITEMAP_SECTION_PATH_PREFIX.pages, row.id);
    case 'groups':
      return isIndexableGroupRow(row) ? uuidPath(SITEMAP_SECTION_PATH_PREFIX.groups, row.id) : null;
    case 'hashtags':
      // Public-by-design like pages; the route is a public prefix and
      // robots.txt already Allows /hashtag/.
      return hashtagPath(row.tag);
    default:
      return null;
  }
}

// The single authority a row has to pass to appear anywhere in the XML.
export function isIndexableSitemapRow(section: SitemapSection, row: SitemapRow): boolean {
  return sitemapRowPath(section, row) !== null;
}

// ---------------------------------------------------------------------------
// Dates (do.md §12)
// ---------------------------------------------------------------------------

// W3C datetime, e.g. 2026-09-27. Never emits a raw column value: an
// unparseable timestamp is dropped rather than published, because a malformed
// <lastmod> makes the whole file invalid.
export function toW3cDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

function absolute(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

// do.md §10/§13 name the children /sitemap-posts-1.xml etc. on the CANONICAL
// origin, so the <loc> values here are frontend-origin, not gateway-origin, even
// though the Gateway is what serves the bytes. The frontend's vercel.json
// rewrites each of these paths onto the Gateway.
export function sitemapChildPath(section: SitemapSection, page: number): string {
  return `/sitemap-${section}-${page}.xml`;
}

export function sitemapEntryFor(
  section: SitemapSection,
  row: SitemapRow,
  baseUrl: string
): SitemapEntry | null {
  const path = sitemapRowPath(section, row);
  if (!path) return null;
  return { loc: absolute(baseUrl, path), lastmod: toW3cDate(row.created_at) };
}

// ---------------------------------------------------------------------------
// The reader seam
// ---------------------------------------------------------------------------

// Keyset cursor (do.md §11 "prefer cursor/keyset pagination based on indexed
// fields rather than large OFFSET values"). `createdAt` is the primary sort key
// normalized to UTC ISO, which is what makes it safe to interpolate into a
// PostgREST `or()` filter: it contains no comma, which is the separator there.
// `name` is the tiebreak - the URL id segment - so the ordering is total and a
// row cannot be returned by two pages.
export interface SitemapCursor {
  createdAt: string | null;
  name: string;
}

export interface SitemapSource {
  /** Upper bound on the section's public row count, for the page count. */
  countSection(section: SitemapSection): Promise<number>;
  /**
   * Up to `limit` rows of `section` strictly after `cursor`, in the section's
   * own order, across every shard that owns the section. May include rows the
   * in-memory predicate will reject - the caller filters and keeps pulling.
   */
  listSection(
    section: SitemapSection,
    cursor: SitemapCursor | null,
    limit: number
  ): Promise<SitemapRow[]>;
}

export class SitemapSectionError extends Error {
  constructor(
    readonly section: SitemapSection,
    message: string
  ) {
    super(`Sitemap section ${section} failed: ${message}`);
    this.name = 'SitemapSectionError';
  }
}

export class SitemapPageOutOfRange extends Error {
  constructor(section: SitemapSection, page: number) {
    super(`Sitemap page out of range: ${section} ${page}`);
    this.name = 'SitemapPageOutOfRange';
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Every section except hashtags is ordered newest-first on `created_at`, with the
// URL id as a total-order tiebreak. Hashtags are ordered by `tag` instead: their
// `created_at` is NULLABLE, and a keyset cursor on a nullable sort column is not
// well defined (a NULL has no position to resume from), whereas `tag` is the
// natural, unique, indexable key for a tag page. The tags are the ones a
// sitemap's tail is made of anyway.
export const SITEMAP_DATE_ORDERED: ReadonlySet<SitemapSection> = new Set<SitemapSection>([
  'posts',
  'reels',
  'photos',
  'profiles',
  'pages',
  'groups',
]);

// The column the cursor's `name` field compares against, per section.
export const SITEMAP_CURSOR_COLUMN: Record<SitemapSection, string> = {
  posts: 'id',
  reels: 'id',
  photos: 'id',
  profiles: 'username',
  pages: 'id',
  groups: 'id',
  hashtags: 'tag',
};

export function cursorForRow(section: SitemapSection, row: SitemapRow): SitemapCursor {
  const created = typeof row.created_at === 'string' ? row.created_at : null;
  const ms = created ? Date.parse(created) : Number.NaN;
  const name =
    section === 'hashtags'
      ? String(row.tag ?? '').trim().toLowerCase()
      : section === 'profiles'
        ? String(row.username ?? '').trim()
        : String(row.id ?? '').trim().toLowerCase();
  return { createdAt: Number.isNaN(ms) ? null : new Date(ms).toISOString(), name };
}

// Newest first, nulls (unknown date) last, then the tiebreak - the same total
// order the reader used, so a page boundary cannot show the same URL twice.
function compareEntries(a: SitemapEntry, b: SitemapEntry): number {
  if (a.lastmod !== b.lastmod) {
    if (a.lastmod === null) return 1;
    if (b.lastmod === null) return -1;
    return a.lastmod < b.lastmod ? 1 : -1;
  }
  return a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0;
}

function isKnownSection(section: string): section is SitemapSection {
  return (SITEMAP_SECTIONS as readonly string[]).includes(section);
}

/**
 * Collect up to `limit` accepted entries for one section, starting at 1-based
 * `page`.
 *
 * The skip is counted in ACCEPTED entries, not raw rows, because the prefilter
 * is only proven to be a superset (see sitemapSource.ts) - so a window of raw
 * rows can be entirely rejected, and counting raw rows would under-fill the page
 * and desynchronize every page after it.
 */
async function collectSectionEntries(
  source: SitemapSource,
  section: SitemapSection,
  baseUrl: string,
  limit: number,
  page: number
): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  let toSkip = Math.max(0, page - 1) * limit;
  let cursor: SitemapCursor | null = null;

  // Bounded so a pathological reader (one that keeps returning rows ignoring the
  // cursor) cannot spin here forever. It is far above the number of pages any
  // real corpus needs, so hitting it means the data is wrong, not merely large.
  const target = limit + toSkip;
  for (let guard = 0; guard <= SITEMAP_MAX_PAGES; guard++) {
    const rows = await source.listSection(section, cursor, SITEMAP_PAGE_SIZE);
    if (rows.length === 0) break;
    // Advance over everything read, accepted or not: a rejected row still
    // consumed a position in the source's order.
    cursor = cursorForRow(section, rows[rows.length - 1]);
    for (const row of rows) {
      const entry = sitemapEntryFor(section, row, baseUrl);
      // Deduped by <loc>: two shards may hold the same id, and a crawler that
      // sees one URL in two files spends budget re-reading it.
      if (!entry || seen.has(entry.loc)) continue;
      seen.add(entry.loc);
      if (toSkip > 0) {
        toSkip--;
        continue;
      }
      entries.push(entry);
    }
    // Stop as soon as the page is full rather than draining the section. Without
    // this, page 1 of a 5-million-row table would read all 5 million rows to
    // return 1000 of them (§9 "load millions of rows into memory unnecessarily",
    // §11 "must be able to process large datasets without timing out").
    if (entries.length >= target) break;
    if (rows.length < SITEMAP_PAGE_SIZE) break;
  }

  return entries.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildSitemapIndexXml(options: {
  children: Array<{ loc: string }>;
  lastmod?: string | null;
}): string {
  // §12: a real date either way. When there is no content, the generation time
  // is a true statement about the file; inventing a date from a row would not be.
  const lastmod = toW3cDate(options.lastmod) ?? new Date().toISOString().slice(0, 10);
  const entries = options.children
    .map(
      (child) =>
        `  <sitemap>\n` +
        `    <loc>${escapeXml(child.loc)}</loc>\n` +
        `    <lastmod>${lastmod}</lastmod>\n` +
        `  </sitemap>`
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n` +
    `</sitemapindex>\n`
  );
}

export function buildSitemapUrlsetXml(options: { entries: SitemapEntry[] }): string {
  const entries = options.entries
    .map(
      (entry) =>
        `  <url>\n` +
        `    <loc>${escapeXml(entry.loc)}</loc>\n` +
        (entry.lastmod ? `    <lastmod>${entry.lastmod}</lastmod>\n` : '') +
        `  </url>`
    )
    .join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n` +
    `</urlset>\n`
  );
}

export interface SitemapRootResult {
  xml: string;
  shape: 'urlset' | 'sitemapindex';
  urlCount: number;
  pageCount: number;
}

/**
 * `GET /sitemap.xml`. Decides the shape from the current data (do.md §13) rather
 * than from configuration: one page of URLs is served inline, more than one page
 * becomes an index.
 *
 * This is the one request that touches every section, so it is the one place to
 * watch §8's "do not query every Supabase project unnecessarily". It issues
 * exactly one count per section (7 fixed queries, in parallel) - never a query
 * per URL - and reuses nothing per-row.
 */
export async function buildSitemapRoot(
  source: SitemapSource,
  options: { baseUrl: string }
): Promise<SitemapRootResult> {
  const baseUrl = options.baseUrl;
  const counts = await Promise.all(SITEMAP_SECTIONS.map((section) => source.countSection(section)));

  const plan = SITEMAP_SECTIONS.map((section, index) => ({ section, count: counts[index] ?? 0 }))
    .map((entry) => ({
      ...entry,
      pages: Math.max(1, Math.min(SITEMAP_MAX_PAGES, Math.ceil(entry.count / SITEMAP_PAGE_SIZE))),
    }))
    // A section with nothing in it is not advertised at all, so the index never
    // sends a crawler to fetch a file that can only be empty.
    .filter((entry) => entry.count > 0);

  // The shape turns on whether everything fits in ONE response, not on how many
  // child files the sections would otherwise be split across. Deciding it on the
  // child count instead would be the complexity §13 rules out: a site with one
  // post, one reel and one photo has three sections, so it would be served a
  // three-child index advertising three files to hold three URLs between them -
  // three extra fetches for the crawler's first visit, over a sitemap that fits
  // in one document.
  const totalCount = plan.reduce((total, entry) => total + entry.count, 0);

  if (totalCount <= SITEMAP_PAGE_SIZE) {
    // Small enough to serve in one response: no index, no child fetches, no
    // extra round trips. Each section contributes at most its own page 1, and
    // the merged result is capped at one page.
    const perSection = await Promise.all(
      plan.map((entry) =>
        collectSectionEntries(source, entry.section, baseUrl, SITEMAP_PAGE_SIZE, 1)
      )
    );
    const merged = new Map<string, SitemapEntry>();
    for (const entries of perSection) for (const entry of entries) merged.set(entry.loc, entry);
    const sorted = [...merged.values()].sort(compareEntries).slice(0, SITEMAP_PAGE_SIZE);
    return { xml: buildSitemapUrlsetXml({ entries: sorted }), shape: 'urlset', urlCount: sorted.length, pageCount: 1 };
  }

  const children = plan.flatMap((entry) =>
    Array.from({ length: entry.pages }, (_, offset) => ({
      loc: absolute(baseUrl, sitemapChildPath(entry.section, offset + 1)),
    }))
  );
  return {
    xml: buildSitemapIndexXml({ children }),
    shape: 'sitemapindex',
    urlCount: 0,
    pageCount: children.length,
  };
}

export async function buildSitemapChild(
  source: SitemapSource,
  options: { baseUrl: string; section: string; page: number }
): Promise<{ xml: string; urlCount: number; section: SitemapSection; page: number }> {
  const { section, page } = options;
  if (!isKnownSection(section)) throw new SitemapPageOutOfRange(section as SitemapSection, page);
  if (!Number.isInteger(page) || page < 1 || page > SITEMAP_MAX_PAGES) {
    throw new SitemapPageOutOfRange(section, page);
  }
  const entries = await collectSectionEntries(source, section, options.baseUrl, SITEMAP_PAGE_SIZE, page);
  return {
    xml: buildSitemapUrlsetXml({ entries }),
    urlCount: entries.length,
    section,
    page,
  };
}
