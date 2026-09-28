// Supabase-backed reader for the public sitemap (see ./sitemap for the shape and
// why the privacy filter is applied per request rather than baked in).
//
// The two-layer filter is deliberate and the layers mean different things.
//
//   layer 1 (this file, a DB prefilter) is an OPTIMIZATION and is required to be
//   a proven SUPERSET of the accepted set: it must never exclude a row the
//   in-memory predicate would have accepted. §9 forbids fetching private content
//   and filtering it in JS, so the prefilter has to be selective - but §2/§14
//   mean it also has to be safe. Both are satisfiable at once, because the
//   accepted audience set is now narrow and provable:
//
//     audience_type  accepted iff `String(v).trim() === 'public'`. A string that
//                    trims to `public` necessarily CONTAINS the substring
//                    `public`, so `like %public%` is a superset. It is
//                    deliberately case-SENSITIVE: 'Public' does not trim to
//                    'public`, is rejected by the predicate, and is correctly
//                    excluded here too.
//
//     status         accepted iff exactly the lowercase literal 'published'
//                    (see isAnonymousReadablePostStatus in ./sitemap: the RLS
//                    CASE falls through to `ELSE false`, so NULL and any other
//                    value are unreadable to an anonymous client and must not be
//                    listed). An exact `eq` is therefore a true superset - it
//                    matches every accepted row and excludes the rest. The
//                    previous prefilter was `status.is.null,status.ilike
//                    .*published*`, a case-WIDENING filter that had to be an
//                    `ilike` because `isPublishedContent` accepted 'Published'
//                    and NULL. That widening guarded two states the schema
//                    cannot store: the column is
//                    `CHECK (status IN ('published','scheduled','draft'))`, so
//                    'Published' is impossible, and no insert path in the app
//                    writes status at all, so every row takes the DEFAULT. It
//                    also fetched rows the sitemap then threw away.
//
//     visibility     NO prefilter at all, and this is not an oversight. The
//                    predicate accepts visibility only when it is absent or also
//                    exactly public, so filtering on it would EXCLUDE rows the
//                    predicate accepts (visibility = null). The prefilter has to
//                    be a superset, and on this column a filter cannot be, so
//                    the column is left to layer 2.
//
//   layer 2 (isIndexableSitemapRow / sitemapRowPath, in ./sitemap) is the
//   AUTHORITY and the only thing standing between the tables and the XML. A row
//   that slipped past layer 1 is still dropped unless the predicate agrees, so
//   there is no code path in which a restricted content id is emitted - and if a
//   prefilter here is ever wrong, it can only ever withhold a URL, never grant
//   one.
//
// do.md §19 - a section that is REGISTERED but unreadable fails the request
// rather than quietly yielding a shorter sitemap. A half-empty sitemap makes a
// crawler deindex the missing URLs over time and tells nobody; a 500 makes the
// crawler retry and makes an operator look. A section whose DOMAIN is not
// registered is not a failure: there is provably no content of that type in this
// deployment, so an empty section is the truthful answer.
import { projectManager } from '../project-manager';
import { PROFILE_INDEXING_OPT_OUT, PROFILE_INDEXING_SETTING } from './profileIndexing';
import {
  cursorForRow,
  isIndexableSitemapRow,
  SITEMAP_CURSOR_COLUMN,
  SITEMAP_DATE_ORDERED,
  SITEMAP_PAGE_SIZE,
  SITEMAP_SECTION_DOMAIN,
  SITEMAP_SECTION_TABLE,
  SitemapSectionError,
  type SitemapCursor,
  type SitemapRow,
  type SitemapSection,
  type SitemapSource,
} from './sitemap';

// Only what the sitemap needs. No content, no media_url, no author, no counts -
// §9's "only retrieve the minimum fields needed to construct sitemap URLs and
// metadata". The posts list carries the three audience/status columns the
// predicate reads plus the two that decide the URL kind, and nothing else.
const POSTS_SELECT = 'id,type,media_type,created_at,audience_type,visibility,status';
const PROFILES_SELECT = 'id,username,created_at';
const PAGES_SELECT = 'id,created_at';
const GROUPS_SELECT = 'id,privacy,created_at';
const HASHTAGS_SELECT = 'tag,created_at';

// §6: the profile search-engine preference, and only that one setting.
// The setting key and the opt-out value both come from the one module that owns
// this question, so a rename on the Privacy Checkup side cannot leave the sitemap
// querying a key or a value that no longer exists. That failure mode has changed
// with the default: under the old opt-in rule a stale key produced an empty
// profiles section (obvious); now it would produce an empty OPT-OUT set, i.e. a
// profiles section that lists everybody. Importing both literals is what keeps
// the two impossible to drift apart.
const PROFILE_OPT_OUT_SETTING = PROFILE_INDEXING_SETTING;
const PROFILE_OPT_OUT_VALUE = PROFILE_INDEXING_OPT_OUT;
const PRIVACY_SETTINGS_SELECT = 'user_id';

// `.in()` is sent as a query string, so the value list is bounded. 250 uuids is
// ~9.5KB of URL, comfortably inside what PostgREST and any proxy in front of it
// accept.
const IN_CHUNK_SIZE = 250;

const PUBLISHED_PREFILTER = 'status.eq.published';
const PUBLIC_AUDIENCE_PREFILTER = 'audience_type.like.*public*';

// `publicContentKind` treats a case-insensitive 'reel' as a reel, so the prefilter
// has to be case-insensitive too or it would under-count the reels section.
const REEL_PREFILTER = 'type.ilike.*reel*';
// `publicContentKind` tests media_type with `=== 'image'`, so this one is exact.
const PHOTO_PREFILTER = 'media_type.eq.image';

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
  limit(count: number): SitemapQuery;
  eq(column: string, value: string): SitemapQuery;
  in(column: string, values: string[]): SitemapQuery;
  ilike(column: string, pattern: string): SitemapQuery;
  gt(column: string, value: string): SitemapQuery;
  select(columns: string, options?: { count?: string; head?: boolean }): SitemapQuery;
}

interface SitemapProject {
  client: { from(table: string): any };
}

function readableProjects(domain: string): SitemapProject[] {
  // This is a read of the already-loaded project cache, not a routing query, so
  // resolving a section costs no database round trip (§8: "load the required
  // project configuration once where appropriate").
  return projectManager.getReadableProjects(domain) as SitemapProject[];
}

function projectsForSection(section: SitemapSection): SitemapProject[] {
  return readableProjects(SITEMAP_SECTION_DOMAIN[section]);
}

// The keyset window (do.md §11). Both halves of the total order are needed:
// `created_at < cursor` OR (`created_at = cursor` AND `tiebreak < cursor`), or a
// boundary row that ties on created_at would repeat on every page.
//
// The values are safe to interpolate because they are either a UTC ISO-8601
// string produced by toISOString() (no comma, which is or()'s separator) or a
// value ./sitemap has already constrained to [A-Za-z0-9_] / uuid / [0-9a-f].
function cursorFilter(section: SitemapSection, cursor: SitemapCursor): string | null {
  if (SITEMAP_DATE_ORDERED.has(section)) {
    if (!cursor.createdAt) return null;
    const column = SITEMAP_CURSOR_COLUMN[section];
    return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},${column}.lt.${cursor.name})`;
  }
  // Hashtags are ordered by tag ascending (see SITEMAP_DATE_ORDERED).
  return `tag.gt.${cursor.name}`;
}

function applyOrder(query: SitemapQuery, section: SitemapSection): SitemapQuery {
  if (SITEMAP_DATE_ORDERED.has(section)) {
    return query
      .order('created_at', { ascending: false })
      .order(SITEMAP_CURSOR_COLUMN[section], { ascending: false });
  }
  return query.order('tag', { ascending: true });
}

function applyCursor(
  query: SitemapQuery,
  section: SitemapSection,
  cursor: SitemapCursor | null
): SitemapQuery {
  if (!cursor) return query;
  const filter = cursorFilter(section, cursor);
  return filter ? query.or(filter) : query;
}

function selectColumns(section: SitemapSection): string {
  switch (section) {
    case 'posts':
    case 'reels':
    case 'photos':
      return POSTS_SELECT;
    case 'profiles':
      return PROFILES_SELECT;
    case 'pages':
      return PAGES_SELECT;
    case 'groups':
      return GROUPS_SELECT;
    case 'hashtags':
      return HASHTAGS_SELECT;
    default:
      return 'id,created_at';
  }
}

// Prefilter per section. Content sections share the status + audience
// superset-filter and differ only in the kind narrowing, which keeps a reel page
// from dragging a thousand ordinary posts through the predicate.
function applySectionPrefilter(
  query: SitemapQuery,
  section: SitemapSection
): SitemapQuery {
  if (section === 'posts' || section === 'reels' || section === 'photos') {
    let next = query.or(PUBLISHED_PREFILTER).or(PUBLIC_AUDIENCE_PREFILTER);
    if (section === 'reels') next = next.or(REEL_PREFILTER);
    if (section === 'photos') next = next.or(PHOTO_PREFILTER);
    return next;
  }
  // Groups: `privacy === 'public'` is the exact literal isIndexableGroupRow
  // tests, so unlike audience this filter is precise rather than a superset.
  if (section === 'groups') return query.eq('privacy', 'public');
  return query;
}

function throwIfError(section: SitemapSection, result: SitemapResult, what: string): SitemapResult {
  if (result.error) {
    // The message is logged, never returned: §19 forbids exposing internal
    // errors (or anything derived from a credential) in the response.
    throw new SitemapSectionError(
      section,
      `${what} failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`
    );
  }
  return result;
}

function asRows(result: SitemapResult): SitemapRow[] {
  return Array.isArray(result.data) ? (result.data as SitemapRow[]) : [];
}

// ---------------------------------------------------------------------------
// profiles: the §6 opt-out, which cannot be joined server-side
// ---------------------------------------------------------------------------

// `privacy_settings.user_id` REFERENCES auth.users(id), not public.profiles, so
// PostgREST has no relationship to embed and the preference cannot be pushed into
// the profiles query. The alternative - reading every opted-OUT id and then
// `.in('id', ...)` - is O(whoever opted out), which is exactly the "load millions
// of rows into memory unnecessarily" §9 rules out, and it grows with the number
// of people who declined rather than with the page.
//
// So it is read the other way round: take the page's profile ids (bounded by the
// page size) and ask which of THOSE opted out. The direction of this query is
// what the default-ON change turns on. Under the old opt-in rule the interesting
// set was small (the people who said yes) and everything else had to be
// excluded; now the interesting set is the people who said NO, and everyone else
// is included by default. Inverting the query rather than the predicate is what
// keeps the cost proportional to the page.
//
// The answer is read fresh on every request - §14 requires it. Under the old
// rule a cache was safe to avoid because a stale answer could only withhold a
// URL; now a stale answer can PUBLISH one, so a cache would be actively unsafe
// and the fresh read is doing real work rather than being belt-and-braces.
function profileOptOutDomain(): string {
  // Same resolution order peopleYouMayKnow.ts uses: the dedicated domain when
  // the live infra registers it, else the `users` host that owns the table in
  // the offline fallback topology.
  return readableProjects('privacy_settings').length > 0 ? 'privacy_settings' : 'users';
}

async function optedOutUserIds(
  section: SitemapSection,
  userIds: string[]
): Promise<Set<string>> {
  const optedOut = new Set<string>();
  if (userIds.length === 0) return optedOut;
  const projects = readableProjects(profileOptOutDomain());
  if (projects.length === 0) {
    // No table to ask. An empty opt-out set means "nobody declined", which under
    // the default-ON rule is the same as "index them all" - so this is now the
    // PERMISSIVE answer, and it is reached only when the table is genuinely not
    // registered. `throwIfError` below still turns a registered-but-failing
    // read into a 500 rather than letting it through as "no opt-outs", which is
    // what keeps a transient database error from publishing an explicit 'false'.
    return optedOut;
  }
  for (let offset = 0; offset < userIds.length; offset += IN_CHUNK_SIZE) {
    const chunk = userIds.slice(offset, offset + IN_CHUNK_SIZE);
    const results = await Promise.all(
      projects.map(async (project) => {
        const query = project.client
          .from('privacy_settings')
          .select(PRIVACY_SETTINGS_SELECT)
          .eq('setting_name', PROFILE_OPT_OUT_SETTING)
          .eq('setting_value', PROFILE_OPT_OUT_VALUE)
          .in('user_id', chunk) as SitemapQuery;
        const result = throwIfError(section, await query, 'privacy_settings read');
        return asRows(result);
      })
    );
    for (const row of results.flat()) {
      const userId = row['user_id'];
      if (typeof userId === 'string' && userId) optedOut.add(userId);
    }
  }
  return optedOut;
}

// Project the resolved preference onto each profile row, so §6's decision stays a
// pure predicate in ./sitemap (`isIndexableProfileRow`) instead of being
// re-implemented here. The projection is deliberately the same two literals the
// predicate understands - a row in the opt-out set is marked 'false' and
// everything else 'true' - so the DB prefilter and the in-memory predicate can
// never disagree about what the column means.
async function markProfileOptOuts(section: SitemapSection, rows: SitemapRow[]): Promise<SitemapRow[]> {
  const ids = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const optedOut = await optedOutUserIds(section, ids);
  return rows.map((row) => ({
    ...row,
    search_engine_indexing: optedOut.has(String(row.id)) ? 'false' : 'true',
  }));
}

// ---------------------------------------------------------------------------
// Merging across shards
// ---------------------------------------------------------------------------

// Newest first (or tag-ascending), with the cursor column as a total-order
// tiebreak. Without the tiebreak, rows sharing a created_at could swap between
// requests and a crawler would see the same URL in two pages.
function compareByCursorOrder(section: SitemapSection, a: SitemapRow, b: SitemapRow): number {
  const column = SITEMAP_CURSOR_COLUMN[section];
  const descending = SITEMAP_DATE_ORDERED.has(section);
  if (descending) {
    const at = Date.parse(typeof a.created_at === 'string' ? a.created_at : '');
    const bt = Date.parse(typeof b.created_at === 'string' ? b.created_at : '');
    if (at !== bt) return (bt || 0) - (at || 0);
  }
  const an = String(a[column] ?? '');
  const bn = String(b[column] ?? '');
  if (an === bn) return 0;
  return descending ? bn.localeCompare(an) : an.localeCompare(bn);
}

function cursorName(section: SitemapSection, row: SitemapRow): string {
  const column = SITEMAP_CURSOR_COLUMN[section];
  const value = String(row[column] ?? '').trim();
  return section === 'hashtags' ? value.toLowerCase() : value;
}

function mergeShards(section: SitemapSection, perProject: SitemapRow[][], limit: number): SitemapRow[] {
  const merged = perProject.flat();
  if (merged.length === 0) return [];
  // Deduped on the cursor column: two shards can hold the same row, and a
  // crawler that reads one URL out of two files spends budget re-fetching it.
  const unique = new Map<string, SitemapRow>();
  for (const row of merged) {
    const key = cursorName(section, row);
    if (key && !unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()].sort((a, b) => compareByCursorOrder(section, a, b)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export function supabaseSitemapSource(): SitemapSource {
  return {
    async countSection(section: SitemapSection): Promise<number> {
      // NOTE on the profiles count, which USED to be special-cased here and no
      // longer is. It asked privacy_settings for the number of opt-ins. Under the
      // default-ON rule that would report 0 for a deployment where nobody has ever
      // opened the privacy checkup - and a count of 0 drops the section from the
      // index entirely, which is the exact bug this round exists to remove.
      //
      // Subtracting a global opt-out count instead was implemented and is wrong,
      // in the direction that matters. `privacy_settings.user_id` references
      // auth.users, so an opt-out count necessarily includes users who have no
      // profile row, and the subtraction under-counts. The caller derives
      // `Math.ceil(count / pageSize)` from this number, so too few means real
      // profile URLs are never advertised, while too many only produces a trailing
      // child file that is empty - which the same doc comment below already calls
      // an acceptable over-count. The over-estimate is therefore free and the
      // under-estimate is not, so profiles fall through to the plain head count
      // with no preference lookup at all. That also drops one table from the set
      // that has to be reachable for the profiles section to render.

      const projects = projectsForSection(section);
      if (projects.length === 0) return 0;
      const counts = await Promise.all(
        projects.map(async (project) => {
          const query = applySectionPrefilter(
            project.client
              .from(SITEMAP_SECTION_TABLE[section])
              .select(selectColumns(section), { count: 'exact', head: true }) as SitemapQuery,
            section
          );
          const result = throwIfError(section, await query, `${SITEMAP_SECTION_TABLE[section]} count`);
          return typeof result.count === 'number' ? result.count : 0;
        })
      );
      // An UPPER BOUND: a head count cannot run the in-memory predicate, so it can
      // over-count a section and leave an empty tail page. A sitemap reader
      // treats an empty urlset as "nothing here", so the failure mode is a
      // slightly wider index, never a wrong or private URL.
      return counts.reduce((total, value) => total + value, 0);
    },

    async listSection(
      section: SitemapSection,
      cursor: SitemapCursor | null,
      limit: number
    ): Promise<SitemapRow[]> {
      if (limit <= 0) return [];
      const projects = projectsForSection(section);
      // An unregistered domain is legitimately empty, not an error: there is no
      // such content in this deployment.
      if (projects.length === 0) return [];

      const perProject = await Promise.all(
        projects.map(async (project) => {
          const base = project.client
            .from(SITEMAP_SECTION_TABLE[section])
            .select(selectColumns(section)) as SitemapQuery;
          const query = applyCursor(applySectionPrefilter(applyOrder(base, section), section), section, cursor);
          const result = throwIfError(
            section,
            await query.limit(limit),
            `${SITEMAP_SECTION_TABLE[section]} read`
          );
          return asRows(result);
        })
      );

      const merged = mergeShards(section, perProject, limit);
      return section === 'profiles' ? markProfileOptOuts(section, merged) : merged;
    },
  };
}

// Re-exported so a caller can size a page without importing two modules.
export { SITEMAP_PAGE_SIZE, isIndexableSitemapRow, cursorForRow };
