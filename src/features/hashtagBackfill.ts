// Hashtag backfill (post-hashtag-fix).
//
// Why this exists: `hashtags` / `hashtag_links` had never been written by the
// app. `Post.tsx` rendered post bodies through `MentionText` (@-only), and the
// Editor publish path never called `saveMentionsAndHashtags` at all. So every
// post and comment that contained a `#tag` before those fixes shipped has a
// caption but no registry row, and is invisible to every hashtag surface.
//
// The fixes only affect NEW content. This module reconciles the existing rows.
//
// Design constraints, all learned from the failure itself:
//
//   * `saveHashtags` (frontend) swallows every failure into a `console.error`.
//     A backfill built on that behaviour would report success while writing
//     nothing — the exact bug being fixed. So every failure here is collected
//     and REPORTED, and the caller decides what to do about it.
//   * `posts` and `comments` are SHARDED across several Supabase projects
//     (`posts_1..3`). Reading "all posts" means `getReadableProjects`, not a
//     single client, so a hand-written SQL script would have to replicate the
//     shard set by hand.
//   * Dry-run by default. The first run should size the backlog, not mutate it.
//
// Idempotent: a tag is upserted on conflict `tag`, and a link is only written
// when no (source_type, source_id, hashtag_id) row exists. Re-running is safe
// and converges.
import { projectManager } from '../project-manager';

/** One hashtag occurrence found in a caption. */
export interface ExtractedTag {
  /** Lowercased, without the `#` — the shape stored in `hashtags.tag`. */
  tag: string;
}

/** A post or comment that carries at least one hashtag. */
export interface TaggedSource {
  source_type: 'post' | 'comment';
  source_id: string;
  tags: string[];
}

export interface BackfillReport {
  dryRun: boolean;
  /** Rows read, per source type. */
  scanned: { posts: number; comments: number };
  /** Sources carrying at least one hashtag. */
  taggedSources: number;
  /** Distinct tags found across all sources. */
  distinctTags: number;
  /** Tags with no `hashtags` row yet. */
  tagsToCreate: string[];
  /** Tag rows that already exist (no write needed). */
  tagsExisting: number;
  /** (source, tag) pairs with no `hashtag_links` row yet. */
  linksToCreate: number;
  /** Link rows that already exist (no write needed). */
  linksExisting: number;
  /** Writes actually performed (always 0 on a dry run). */
  written: { tags: number; links: number };
  /**
   * Every failure and every blocker found, including whether the target domains
   * are writable at all — reported on dry runs too, so a dry run can predict a
   * write run. NON-EMPTY MEANS THE BACKFILL COULD NOT COMPLETE: the registry may
   * still be incomplete, so the run should be repeated once the cause is fixed.
   * This is the signal that must not be swallowed, given the bug this exists to
   * fix was itself a swallowed failure.
   */
  failures: Array<{ operation: string; detail: string }>;
}

export interface BackfillOptions {
  /** When true (the default) nothing is written. */
  dryRun?: boolean;
  /** Rows fetched per shard per page. */
  pageSize?: number;
  /** Safety valve on total pages read per source type. */
  maxPages?: number;
}

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 200;

const POSTS_SELECT = 'id,content,status';
const COMMENTS_SELECT = 'id,content';
const HASHTAGS_SELECT = 'id,tag';
const LINKS_SELECT = 'source_type,source_id,hashtag_id';

/**
 * Extract unique hashtags from text.
 *
 * Deliberately identical in behaviour to the frontend's `extractHashtags`
 * (`tone-your-social-voice/src/utils/hashtags.ts`): same pattern, same
 * lowercasing, same de-duplication. The two repos cannot share a module, so the
 * contract is pinned by tests on both sides instead — see
 * hashtagBackfillTest.ts. If you change one, change the other.
 */
export function extractHashtags(text: string): string[] {
  const hashtagRegex = /#(\w+)/g;
  const matches = text.matchAll(hashtagRegex);
  const hashtags = Array.from(matches, (match) => match[1].toLowerCase());
  return [...new Set(hashtags)];
}

interface ShardClient {
  from(table: string): any;
}

function readableShards(domain: string): ShardClient[] {
  return projectManager.getReadableProjects(domain).map((entry) => entry.client as ShardClient);
}

/** The default identity of a row: its primary key. */
function byId(row: Record<string, any>): string | null {
  return typeof row?.id === 'string' ? row.id : null;
}

/**
 * The identity of a `hashtag_links` row. It has NO `id` column — its identity is
 * the (source, tag) triple. Keying on `id` alone would silently discard every
 * link row, which would make `existingLinks` permanently empty and turn every
 * re-run into a full duplicate insert. That is the whole point of this backfill,
 * so the key is stated explicitly rather than assumed.
 */
function byLinkKey(row: Record<string, any>): string | null {
  const { source_type, source_id, hashtag_id } = row ?? {};
  if (
    typeof source_type !== 'string' ||
    typeof source_id !== 'string' ||
    typeof hashtag_id !== 'string'
  ) {
    return null;
  }
  return `${source_type} ${source_id} ${hashtag_id}`;
}

/**
 * Read `columns` from every shard of `domain`, paging until a shard returns a
 * short page.
 *
 * Each shard is paged independently and the results concatenated. `keyOf` gives
 * each row its identity for de-duplication; shards are disjoint, so this is
 * belt-and-braces against a shard being registered twice.
 *
 * A row whose identity cannot be determined is DROPPED, not passed through with
 * an unknown key: silently keeping it would corrupt the diff. `failures` records
 * nothing for these, so the caller sees a smaller `scanned` count instead of an
 * error — which is why every caller here selects a column set that does yield a
 * key.
 */
async function readAllShards(
  domain: string,
  table: string,
  columns: string,
  pageSize: number,
  maxPages: number,
  failures: BackfillReport['failures'],
  keyOf: (row: Record<string, any>) => string | null = byId
): Promise<Record<string, any>[]> {
  const rows: Record<string, any>[] = [];
  const seen = new Set<string>();

  for (const client of readableShards(domain)) {
    for (let page = 0; page < maxPages; page++) {
      const from = page * pageSize;
      const to = from + pageSize - 1;
      let result: { data: unknown; error: unknown };
      try {
        result = await client.from(table).select(columns).range(from, to);
      } catch (thrown) {
        // A thrown error (network, DNS) never reaches `.error` — record it and
        // stop this shard rather than aborting the whole run.
        failures.push({
          operation: `read ${table}`,
          detail: thrown instanceof Error ? thrown.message : String(thrown),
        });
        break;
      }
      if (result.error) {
        failures.push({
          operation: `read ${table}`,
          detail:
            result.error instanceof Error ? result.error.message : String(result.error),
        });
        break;
      }
      const batch = Array.isArray(result.data) ? (result.data as Record<string, any>[]) : [];
      for (const row of batch) {
        const key = keyOf(row);
        if (key === null || seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
      if (batch.length < pageSize) break;
    }
  }
  return rows;
}

/** Turn raw rows into the distinct (source, tag) pairs that need a link row. */
function collectTaggedSources(
  rows: Record<string, any>[],
  sourceType: 'post' | 'comment'
): TaggedSource[] {
  const out: TaggedSource[] = [];
  for (const row of rows) {
    const content = typeof row?.content === 'string' ? row.content : '';
    if (!content) continue;
    const tags = extractHashtags(content);
    if (tags.length === 0) continue;
    if (typeof row.id !== 'string') continue;
    out.push({ source_type: sourceType, source_id: row.id, tags });
  }
  return out;
}

export async function runHashtagBackfill(
  options: BackfillOptions = {}
): Promise<BackfillReport> {
  const dryRun = options.dryRun !== false;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const failures: BackfillReport['failures'] = [];

  const report: BackfillReport = {
    dryRun,
    scanned: { posts: 0, comments: 0 },
    taggedSources: 0,
    distinctTags: 0,
    tagsToCreate: [],
    tagsExisting: 0,
    linksToCreate: 0,
    linksExisting: 0,
    written: { tags: 0, links: 0 },
    failures,
  };

  // --- can this deployment write at all? ------------------------------------
  // Resolved FIRST, and reported on every run including a dry one, because it is
  // the single most valuable unknown before the first successful write.
  //
  // `hashtags` reads fine as a guest yet has never had an app-written row, which
  // is exactly the signature of a domain that is readable but NOT writable (no
  // `write_enabled`, or over the capacity threshold). A dry run that skipped this
  // would report a clean, plausible-looking backlog, and the operator would only
  // discover they were not ready on the mutating run — after asking for the
  // change to be made. A dry run that answers "would this actually work?" is
  // worth the two extra lines.
  const hashtagsDomain = 'hashtags';
  const linksDomain = 'hashtag_links';
  const writableHashtags = projectManager.getWritableProject(hashtagsDomain);
  const writableLinks = projectManager.getWritableProject(linksDomain);
  if (!writableHashtags) {
    failures.push({
      operation: 'resolve writable project',
      detail: `No writable project for domain: ${hashtagsDomain}`,
    });
  }
  if (!writableLinks) {
    failures.push({
      operation: 'resolve writable project',
      detail: `No writable project for domain: ${linksDomain}`,
    });
  }

  // --- read the sources -----------------------------------------------------
  const postRows = await readAllShards('posts', 'posts', POSTS_SELECT, pageSize, maxPages, failures);
  const commentRows = await readAllShards(
    'comments',
    'comments',
    COMMENTS_SELECT,
    pageSize,
    maxPages,
    failures
  );
  report.scanned.posts = postRows.length;
  report.scanned.comments = commentRows.length;

  const sources: TaggedSource[] = [
    ...collectTaggedSources(postRows, 'post'),
    ...collectTaggedSources(commentRows, 'comment'),
  ];
  report.taggedSources = sources.length;

  const allTags = [...new Set(sources.flatMap((s) => s.tags))].sort();
  report.distinctTags = allTags.length;
  if (allTags.length === 0) return report;

  // --- read what already exists --------------------------------------------
  const existingTagRows = await readAllShards(
    hashtagsDomain,
    'hashtags',
    HASHTAGS_SELECT,
    pageSize,
    maxPages,
    failures
  );
  const existingLinkRows = await readAllShards(
    linksDomain,
    'hashtag_links',
    LINKS_SELECT,
    pageSize,
    maxPages,
    failures,
    byLinkKey
  );

  const tagIdByTag = new Map<string, string>();
  for (const row of existingTagRows) {
    if (typeof row?.tag === 'string' && typeof row.id === 'string') {
      tagIdByTag.set(row.tag.toLowerCase(), row.id);
    }
  }
  const existingLinks = new Set<string>();
  for (const row of existingLinkRows) {
    if (
      typeof row?.source_type === 'string' &&
      typeof row?.source_id === 'string' &&
      typeof row?.hashtag_id === 'string'
    ) {
      existingLinks.add(`${row.source_type} ${row.source_id} ${row.hashtag_id}`);
    }
  }

  // --- compute the diff -----------------------------------------------------
  const missingTags = allTags.filter((tag) => !tagIdByTag.has(tag));
  report.tagsToCreate = missingTags;
  report.tagsExisting = allTags.length - missingTags.length;

  // Every (source, tag) pair the registry is missing. Deduplicated on the
  // source+tag key, not on the link row, because a missing tag has no id yet.
  const wantedLinks = new Map<string, { source_type: string; source_id: string; tag: string }>();
  for (const source of sources) {
    for (const tag of source.tags) {
      wantedLinks.set(`${source.source_type} ${source.source_id} ${tag}`, {
        source_type: source.source_type,
        source_id: source.source_id,
        tag,
      });
    }
  }

  const pendingLinks: Array<{ source_type: string; source_id: string; tag: string }> = [];
  for (const wanted of wantedLinks.values()) {
    const hashtagId = tagIdByTag.get(wanted.tag);
    if (hashtagId && existingLinks.has(`${wanted.source_type} ${wanted.source_id} ${hashtagId}`)) {
      report.linksExisting += 1;
      continue;
    }
    pendingLinks.push(wanted);
  }
  report.linksToCreate = pendingLinks.length;

  // Resolve writability BEFORE the dry-run return, so a dry run answers "would
  // this actually work?" and not merely "what would change?". See the top of
  // this function: this is the check that matters most while no write has ever
  // succeeded.
  if (dryRun || failures.length > 0) {
    // Either the caller asked for a dry run, or something is already known to be
    // wrong: a read failure means the diff above was computed from an incomplete
    // view, so writing would create a partial — and misleading — registry.
    // Report and stop; the caller re-runs once the cause is fixed.
    return report;
  }

  // --- write ----------------------------------------------------------------
  // Both resolved above, and both known non-null because any failure here would
  // have returned already.
  const hashtagsClient = writableHashtags!.client as ShardClient;
  const linksClient = writableLinks!.client as ShardClient;

  // 1. Create the missing tag rows. `onConflict: 'tag'` matches the frontend's
  //    `saveHashtags` and makes this safe to re-run.
  for (const tag of missingTags) {
    try {
      const { data, error } = await hashtagsClient
        .from('hashtags')
        .upsert({ tag }, { onConflict: 'tag' })
        .select('id')
        .single();
      if (error) {
        failures.push({ operation: `upsert hashtags ${tag}`, detail: describe(error) });
        continue;
      }
      const id = (data as { id?: unknown } | null)?.id;
      if (typeof id === 'string') {
        tagIdByTag.set(tag, id);
        report.written.tags += 1;
      } else {
        failures.push({ operation: `upsert hashtags ${tag}`, detail: 'no id returned' });
      }
    } catch (thrown) {
      failures.push({ operation: `upsert hashtags ${tag}`, detail: describe(thrown) });
    }
  }

  // 2. Create the missing link rows. Skipped where the tag could not be
  //    resolved, so a tag failure never produces an orphan link.
  for (const link of pendingLinks) {
    const hashtagId = tagIdByTag.get(link.tag);
    if (!hashtagId) {
      failures.push({
        operation: `link ${link.source_type} ${link.source_id} ${link.tag}`,
        detail: 'skipped: hashtag id unavailable',
      });
      continue;
    }
    if (existingLinks.has(`${link.source_type} ${link.source_id} ${hashtagId}`)) continue;
    try {
      const { error } = await linksClient.from('hashtag_links').insert({
        source_type: link.source_type,
        source_id: link.source_id,
        hashtag_id: hashtagId,
      });
      if (error) {
        failures.push({
          operation: `insert hashtag_links ${link.source_type} ${link.source_id}`,
          detail: describe(error),
        });
        continue;
      }
      existingLinks.add(`${link.source_type} ${link.source_id} ${hashtagId}`);
      report.written.links += 1;
    } catch (thrown) {
      failures.push({
        operation: `insert hashtag_links ${link.source_type} ${link.source_id}`,
        detail: describe(thrown),
      });
    }
  }

  return report;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    return String((value as { message: unknown }).message);
  }
  return String(value);
}

/**
 * Whether `callerId` may run the backfill, given the raw
 * `HASHTAG_BACKFILL_ADMIN_IDS` env value.
 *
 * DENIED BY DEFAULT. An unset, empty, or whitespace-only value denies everyone,
 * so deploying the endpoint without configuring it cannot expose a bulk write
 * path — the failure mode of "I forgot the env var" is a closed door, not an
 * open one. An empty `callerId` is likewise never allowed, because an
 * unauthenticated request must not match an empty entry in the list.
 *
 * The explicit `allowed.length === 0` check is redundant today: the parsing
 * below turns an all-blank value into `[]`, which matches nobody anyway. It is
 * kept so the deny-by-default guarantee does not rest on that parsing detail —
 * an edit to the split/trim/filter chain could not silently invert it. The tests
 * pin the observable behaviour (an unconfigured env denies), which holds either
 * way.
 */
export function isHashtagBackfillAuthorized(envValue: string | undefined, callerId: string | undefined | null): boolean {
  const allowed = (envValue || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  const caller = (callerId || '').trim();
  if (caller === '') return false;
  return allowed.includes(caller);
}

/**
 * Whether the request asked for a real write.
 *
 * FALSE BY DEFAULT, and only an explicit boolean `false` opts in. Absent, `null`,
 * `"false"` (a string), `0`, and every other malformed value stay a dry run,
 * because this is the difference between mutating every hashtag row in the
 * deployment and reading them. A caller who wants a write has to be precise.
 */
export function parseBackfillDryRun(body: unknown): boolean {
  const dryRun = (body as { dryRun?: unknown } | null | undefined)?.dryRun;
  return dryRun !== false;
}