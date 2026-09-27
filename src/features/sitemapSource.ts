// Supabase-backed reader for the public sitemap (see ./sitemap for the shape and
// why the audience filter is applied per request rather than baked in).
//
// The two-layer filter is deliberate and the layers mean different things:
//
//   layer 1 (this file, a DB prefilter on `status` ONLY) is an OPTIMIZATION. It
//   cannot be trusted to be correct and nothing downstream depends on it for
//   safety - it only avoids dragging every draft through the process just to
//   throw it away. It deliberately does NOT prefilter on the audience columns:
//   any prefilter expressible in PostgREST has to enumerate audience spellings
//   case-sensitively, which is exactly the bug this work fixes (a public post
//   stored as 'Public' was already being withheld from crawlers), so a prefilter
//   would have reintroduced it one layer down. Audience is layer 2's job only.
//
//   layer 2 (isIndexablePublicRow, the canonical predicate) is the AUTHORITY and
//   the only thing standing between the table and the XML. A row that slipped
//   past layer 1 is still dropped unless `isGuestSafePublicAudience` agrees, so
//   there is no code path in which a restricted content id is emitted.
//
// `countPublicContent` applies the identical filter as `listPublicContent` on
// purpose: if the two disagreed the index would advertise segments that 404, or
// hide segments that exist, and both are crawl-budget bugs a crawler cannot
// recover from on its own.
// The prefilter may over-approximate because the read selects only six columns -
// no content, no media URL, no author column - so a restricted row contributes
// nothing but a rejected object to this process.
//
// `countPublicContent` counts the same prefiltered set as `listPublicContent` so
// the index does not advertise segments that 404, or hide segments that exist.
// It is an upper bound (a head-count cannot run the in-memory predicate), which
// at worst yields an empty tail segment; a sitemap reader treats that as
// "nothing here", so the failure mode is a slightly wider index, never a wrong
// URL.
import { projectManager } from '../project-manager';
import {
  isIndexablePublicRow,
  SITEMAP_PAGE_SIZE,
  type PublicContentSource,
  type SitemapContentRow,
} from './sitemap';

// Only what the sitemap needs: the id and type to build a URL, the timestamp for
// <lastmod>, and the three columns the audience predicate reads.
const SITEMAP_SELECT = 'id,type,media_type,created_at,audience_type,visibility,status';

const PUBLISHED_PREFILTER = 'status.is.null,status.eq.published';

// Mirrors the PostgREST builder this reader chains over. `from()` returns `any`
// deliberately (same as the existing `ReactionClient` in reactionUsers.ts) so
// `CachedProject` casts cleanly; the chain is what is typed here.
interface SitemapResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

interface SitemapQuery extends PromiseLike<SitemapResult> {
  or(filter: string): SitemapQuery;
  order(column: string, options: { ascending: boolean }): SitemapQuery;
  range(from: number, to: number): SitemapQuery;
}

interface SitemapProject {
  client: { from(table: string): any };
}

function readableSitemapProjects(): SitemapProject[] {
  return projectManager.getReadableProjects('posts') as SitemapProject[];
}

function applyPrefilters(query: SitemapQuery): SitemapQuery {
  return query
    .or(PUBLISHED_PREFILTER)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
}

// Newest first, with the id as a tiebreak so the ordering is total and stable
// across the two shards. Without the tiebreak, rows sharing a created_at could
// swap between requests and a crawler would see the same URL in two segments.
function compareNewestFirst(a: SitemapContentRow, b: SitemapContentRow): number {
  const at = Date.parse(typeof a.created_at === 'string' ? a.created_at : '') || 0;
  const bt = Date.parse(typeof b.created_at === 'string' ? b.created_at : '') || 0;
  if (at !== bt) return bt - at;
  return String(b.id ?? '').localeCompare(String(a.id ?? ''));
}

export function supabasePublicContentSource(): PublicContentSource {
  return {
    async listPublicContent(offset: number, limit: number): Promise<SitemapContentRow[]> {
      const projects = readableSitemapProjects();
      if (projects.length === 0 || limit <= 0 || offset < 0) return [];
      const needed = offset + limit;

      // The audience filter runs AFTER the read, so a window of raw rows can be
      // entirely restricted. Stopping at the first short window would
      // under-fill a segment, and because the index sizes segments from a
      // separate count, a short segment would desynchronize every segment after
      // it. So keep pulling windows until enough public rows have accumulated or
      // every shard is exhausted.
      const rawWindow = Math.max(limit, SITEMAP_PAGE_SIZE);
      const collected: SitemapContentRow[] = [];
      let scanned = 0;

      while (collected.length < needed) {
        const perProject = await Promise.all(
          projects.map(async (project) => {
            try {
              const query = applyPrefilters(project.client.from('posts').select(SITEMAP_SELECT));
              const { data, error } = await query.range(scanned, scanned + rawWindow - 1);
              if (error || !Array.isArray(data)) return [] as SitemapContentRow[];
              return data as SitemapContentRow[];
            } catch {
              // A single unreadable shard must not take down the sitemap for the
              // others. It can only make the sitemap SHORTER (those rows are
              // simply not listed), never list something restricted.
              return [] as SitemapContentRow[];
            }
          })
        );
        const window = perProject.flat();
        if (window.length === 0) break;
        scanned += window.length;
        collected.push(...window.filter(isIndexablePublicRow));
      }

      return collected.sort(compareNewestFirst).slice(offset, needed);
    },

    async countPublicContent(): Promise<number> {
      const projects = readableSitemapProjects();
      if (projects.length === 0) return 0;
      const counts = await Promise.all(
        projects.map(async (project) => {
          try {
            const query = applyPrefilters(project.client.from('posts').select(SITEMAP_SELECT, {
              count: 'exact',
              head: true,
            }));
            const { count, error } = await query;
            return error || typeof count !== 'number' ? 0 : count;
          } catch {
            return 0;
          }
        })
      );
      // A head-count cannot apply the in-memory predicate, so this is an upper
      // bound on the public row count and can advertise an empty tail segment.
      // Sitemap readers treat that as "nothing here", so the failure mode is a
      // slightly wider index, never a wrong URL.
      return counts.reduce((total, value) => total + value, 0);
    },
  };
}
