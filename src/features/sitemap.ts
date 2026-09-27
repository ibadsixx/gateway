// Public sitemap / sitemap index for crawlable content (do.md "Sitemap/discovery").
//
// The important property is that this is NOT a generated file. Nothing here is
// written to disk, cached, or precomputed, so it cannot go stale: every request
// re-reads the posts table and re-evaluates each row's audience through the one
// canonical predicate (`isGuestSafePublicAudience`). That is what makes the four
// required transitions fall out for free rather than needing invalidation:
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
// reach the XML.
//
// Shape (a sitemap INDEX of paginated sitemaps, never one huge file):
//
//   GET /api/sitemap.xml            -> <sitemapindex> listing N <sitemap>
//   GET /api/sitemap/0.xml          -> <urlset> newest 1000 public URLs
//   GET /api/sitemap/1.xml          -> the next 1000, older
//   ...
//
// Segments are a fixed page size ordered newest-first, so a segment boundary
// only ever shifts as content is added at the head; crawlers re-read the index
// and pick up the shift. This is the standard dynamic-sitemap trade: no
// per-segment manifest to keep in sync, at the cost of a small amount of
// re-fetching after publication, which is what Google recommends anyway.
import { isGuestSafePublicContent } from './contentAudience';
import type { AudienceRow } from './contentAudience';

export type SitemapContentRow = AudienceRow & {
  id?: unknown;
  type?: unknown;
  media_type?: unknown;
  media_url?: unknown;
  created_at?: unknown;
};

// Google's hard ceiling is 50,000 URLs per sitemap file and 50MB uncompressed.
export const SITEMAP_PAGE_SIZE = 1000;
// Enough segments that the 50k/file ceiling is never the binding constraint,
// while still refusing to build an unbounded index if a count ever goes wrong.
export const SITEMAP_MAX_SEGMENTS = 2000;

export type PublicContentKind = 'post' | 'reel' | 'photo';

export interface PublicContentEntry {
  id: string;
  kind: PublicContentKind;
  path: string;
  lastmod: string | null;
}

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
export function publicContentKind(row: SitemapContentRow): PublicContentKind {
  if (typeof row.type === 'string' && row.type.trim().toLowerCase() === 'reel') return 'reel';
  if (row.media_type === 'image') return 'photo';
  return 'post';
}

export function publicContentPath(
  row: Pick<SitemapContentRow, 'id' | 'type' | 'media_type'>
): string | null {
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;
  // A post id is a uuid; a path segment built from anything else (an injected
  // `../`, a newline, a quote) could either escape the prefix or break out of
  // the XML attribute, so the sitemap only ever emits verified uuids.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  return `${PUBLIC_CONTENT_PATH_PREFIX[publicContentKind(row)]}${id.toLowerCase()}`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// W3C datetime, e.g. 2026-09-27. Never emits a raw column value: an
// unparseable timestamp is dropped rather than published, because a malformed
// <lastmod> makes the whole file invalid.
function toW3cDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildSitemapIndexXml(options: {
  segments: Array<{ segment: number; url: string }>;
  lastmod?: string | null;
}): string {
  const lastmod = toW3cDate(options.lastmod) ?? new Date().toISOString().slice(0, 10);
  const entries = options.segments
    .map(
      (segment) =>
        `  <sitemap>\n` +
        `    <loc>${escapeXml(segment.url)}</loc>\n` +
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

export function buildSitemapUrlsetXml(options: {
  entries: Array<{ loc: string; lastmod: string | null }>;
}): string {
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

// The reader the sitemap needs. Kept as an interface so the audience rules can
// be tested exhaustively offline without a database, and so the route handler
// stays a thin adapter over the real Supabase projects.
export interface PublicContentSource {
  /** Public rows only, newest first, `offset` 0-based. */
  listPublicContent(offset: number, limit: number): Promise<SitemapContentRow[]>;
  /** How many public rows exist, for the segment count. */
  countPublicContent(): Promise<number>;
}

export function isIndexablePublicRow(row: SitemapContentRow): boolean {
  if (!row || typeof row !== 'object') return false;
  if (!isGuestSafePublicContent(row)) return false;
  // The audience predicate already guarantees a guest may read the row, but a
  // row with no id cannot be turned into a URL, and `publicContentPath`
  // rejecting it is the last gate before the XML.
  return publicContentPath(row) !== null;
}

function absolute(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${path}`;
}

export async function buildPublicSitemapIndex(
  source: PublicContentSource,
  options: { baseUrl: string }
): Promise<{ xml: string; segmentCount: number }> {
  const total = Math.max(0, await source.countPublicContent());
  const segmentCount = Math.max(1, Math.min(SITEMAP_MAX_SEGMENTS, Math.ceil(total / SITEMAP_PAGE_SIZE)));
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    segment: index,
    url: absolute(options.baseUrl, `/api/sitemap/${index}.xml`),
  }));
  const newest = await source.listPublicContent(0, 1);
  const lastmod = toW3cDate(newest[0]?.created_at);
  return { xml: buildSitemapIndexXml({ segments, lastmod }), segmentCount };
}

export async function buildPublicSitemapPage(
  source: PublicContentSource,
  options: { baseUrl: string; segment: number }
): Promise<{ xml: string; urlCount: number; lastmod: string | null }> {
  const segment = options.segment;
  if (!Number.isInteger(segment) || segment < 0 || segment >= SITEMAP_MAX_SEGMENTS) {
    throw new SitemapSegmentOutOfRange(segment);
  }
  const rows = await source.listPublicContent(segment * SITEMAP_PAGE_SIZE, SITEMAP_PAGE_SIZE);
  const entries = [];
  for (const row of rows) {
    const path = publicContentPath(row);
    if (!path) continue;
    entries.push({ loc: absolute(options.baseUrl, path), lastmod: toW3cDate(row.created_at) });
  }
  const lastmod = entries.length > 0 ? entries[0].lastmod : null;
  return { xml: buildSitemapUrlsetXml({ entries }), urlCount: entries.length, lastmod };
}

export class SitemapSegmentOutOfRange extends Error {
  constructor(segment: number) {
    super(`Sitemap segment out of range: ${segment}`);
    this.name = 'SitemapSegmentOutOfRange';
  }
}
