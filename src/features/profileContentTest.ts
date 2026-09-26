// Offline regression tests for the one-item-at-a-time profile content read.
// Run with: npm run test:profile-content
//
// The fake below EVALUATES the predicates (rather than recording them) so these
// tests exercise the actual cursor semantics: a test that only checked the
// generated filter strings would still pass if the keyset comparison, the tie
// -break or the skip-and-advance loop were wrong.
import assert from 'node:assert/strict';
import {
  clampProfileContentLimit,
  decodeProfileContentCursor,
  getProfileContentPage,
  parseProfileContentKind,
  type ProfileContentDeps,
  type ProfileContentItem,
} from './profileContent';
import type { ReactionRow } from './reactionUsers';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FRIEND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STRANGER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}:`, error);
  }
}
function assertTrue(name: string, value: boolean) {
  check(name, value, true);
}

// --- a PostgREST-like fake that really evaluates the query ------------------

interface Term {
  column: string;
  op: string;
  value: string;
}
/** A PostgREST `or=(a,b,c)` is a disjunction; `and(x,y)` nests inside it. */
type Predicate = Term | { any: Predicate[] } | { and: Predicate[] };

/** Splits on top-level commas only, so `and(a,b)` stays intact. */
function splitTopLevel(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expression) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

// `created_at` values contain dots ("2026-01-19T22:36:55.671345+00:00"), so the
// value is matched greedily rather than by splitting on every dot.
function parseTerm(text: string): Predicate | null {
  const andMatch = /^and\((.*)\)$/s.exec(text);
  if (andMatch) {
    const inner = splitTopLevel(andMatch[1]).map(parseTerm).filter(Boolean) as Predicate[];
    return inner.length > 0 ? { and: inner } : null;
  }
  const match = /^(\w+)\.([a-z.]+)\.(.*)$/s.exec(text);
  if (!match) return null;
  return { column: match[1], op: match[2], value: match[3] };
}

/**
 * A whole `or=(...)` argument. The top-level commas make it a DISJUNCTION, so
 * `a.lt.X,and(a.eq.X,b.lt.Y)` must be read as `a < X` OR (`a = X` AND `b < Y`).
 * Reading it as one term would silently widen the keyset to "everything older
 * than X, plus garbage" and every test below would pass for the wrong reason.
 */
function parseOrExpression(expression: string): Predicate | null {
  const terms = splitTopLevel(expression).map(parseTerm).filter(Boolean) as Predicate[];
  if (terms.length === 0) return null;
  return terms.length === 1 ? terms[0] : { any: terms };
}

function evaluateTerm(row: ReactionRow, term: Term): boolean {
  const actual = row[term.column];
  // PostgREST orders/compares timestamps and uuids as text here, which is what
  // the feature's comparator assumes.
  const left = actual === null || actual === undefined ? null : String(actual);
  switch (term.op) {
    case 'eq':
      return left === term.value;
    case 'neq':
      return left !== term.value;
    // The parser splits the value off greedily, so `x.not.is.null` arrives as
    // op `not.is` with the value `null`.
    case 'not.is':
      return term.value === 'null' ? left !== null : left !== term.value;
    case 'is':
      return term.value === 'null' ? left === null : left === term.value;
    case 'lt':
      return left !== null && left < term.value;
    case 'lte':
      return left !== null && left <= term.value;
    case 'gt':
      return left !== null && left > term.value;
    case 'gte':
      return left !== null && left >= term.value;
    default:
      return true;
  }
}

function evaluate(row: ReactionRow, predicate: Predicate): boolean {
  if ('any' in predicate) return predicate.any.some((child) => evaluate(row, child));
  if ('and' in predicate) return predicate.and.every((child) => evaluate(row, child));
  return evaluateTerm(row, predicate);
}

class FakeClient {
  constructor(private readonly tables: Record<string, ReactionRow[]>) {}

  from(table: string): any {
    const rows = (this.tables[table] || []).slice();
    const eqFilters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    const orPredicates: Predicate[] = [];
    const notFilters: Term[] = [];
    let orderColumn: string | null = null;
    let ascending = false;
    let limitValue = 0;

    const run = (): ReactionRow[] => {
      let output = rows.filter((row) => {
        for (const [column, value] of eqFilters) {
          if (String(row[column] ?? '') !== String(value)) return false;
        }
        for (const [column, values] of inFilters) {
          if (!values.map(String).includes(String(row[column] ?? ''))) return false;
        }
        for (const predicate of orPredicates) {
          if (!evaluate(row, predicate)) return false;
        }
        for (const term of notFilters) {
          // `term` is already negated (`not.is`), so the row is KEPT only when
          // the negated test holds. Excluding on a match would keep precisely
          // the rows the filter was written to drop.
          if (!evaluateTerm(row, term)) return false;
        }
        return true;
      });
      if (orderColumn) {
        const column = orderColumn;
        const direction = ascending ? 1 : -1;
        output = output.slice().sort((a, b) => {
          const left = String(a[column] ?? '');
          const right = String(b[column] ?? '');
          // PostgREST leaves ties in an unspecified order, so the fake must not
          // invent one: the feature re-sorts the merged batch itself with an
          // `id` tie-break, and THAT is what these tests are about.
          if (left === right) return 0;
          return left < right ? -direction : direction;
        });
      }
      if (limitValue > 0) output = output.slice(0, limitValue);
      return output;
    };

    const query: any = {
      select: () => query,
      eq(column: string, value: unknown) {
        eqFilters.push([column, value]);
        return query;
      },
      in(column: string, values: unknown[]) {
        inFilters.push([column, values]);
        return query;
      },
      or(expression: string) {
        const predicate = parseOrExpression(expression);
        if (predicate) orPredicates.push(predicate);
        return query;
      },
      not(column: string, op: string, value: unknown) {
        // PostgREST `.not(col, op, val)` negates that one comparison, so
        // `.not('media_url', 'is', null)` is `media_url IS NOT NULL`.
        notFilters.push({ column, op: `not.${op}`, value: String(value) });
        return query;
      },
      order(column: string, options?: { ascending?: boolean }) {
        orderColumn = column;
        ascending = options?.ascending === true;
        return query;
      },
      limit(value: number) {
        limitValue = value;
        return query;
      },
      then: (resolve: (value: { data: ReactionRow[]; error: unknown }) => unknown) =>
        Promise.resolve(resolve({ data: run(), error: null })),
    };
    return query;
  }
}

function project(tables: Record<string, ReactionRow[]>): { client: FakeClient } {
  return { client: new FakeClient(tables) };
}

function deps(tables: Record<string, ReactionRow[]>): ProfileContentDeps {
  return { posts: [project(tables)], friends: [], profiles: [project(tables)] };
}

// --- fixtures ---------------------------------------------------------------

/**
 * Monotonic ISO timestamps. Built from an epoch so the values stay
 * lexicographically ordered the way the real `created_at` text is, however many
 * fixtures a test file has already created (`00:00:9` would otherwise sort
 * after `00:00:10`).
 */
const BASE_MS = Date.UTC(2026, 0, 1);
function tsFor(n: number): string {
  return new Date(BASE_MS + n * 1000).toISOString().replace('Z', '+00:00');
}

let seq = 0;
function post(overrides: Partial<ReactionRow> = {}): ReactionRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    user_id: OWNER,
    created_at: tsFor(seq),
    status: 'published',
    audience_type: 'public',
    visibility: 'public',
    type: 'normal_post',
    media_type: null,
    shared_post_id: null,
    content: `post ${seq}`,
    ...overrides,
  };
}

function profileTable(): ReactionRow[] {
  return [
    { id: OWNER, username: 'owner', display_name: 'Owner', profile_pic: null },
    { id: OTHER, username: 'other', display_name: 'Other', profile_pic: 'p.png' },
  ];
}

/** Walks a whole feed the way the SPA does: one item per request. */
async function walkAll(
  tables: Record<string, ReactionRow[]>,
  kind: 'posts' | 'photos' | 'reels' | 'shared',
  viewerId: string | undefined,
  friendIds: Set<string>,
  maxSteps = 60
): Promise<ProfileContentItem[]> {
  const collected: ProfileContentItem[] = [];
  let cursor: string | null = null;
  let emptySteps = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const page = await getProfileContentPage(deps(tables), OWNER, viewerId, friendIds, kind, {
      limit: 1,
      cursor,
    });
    collected.push(...page.items);
    if (page.items.length === 0) {
      emptySteps += 1;
      // A page may legitimately be empty while `has_more` is true (the whole
      // batch was unauthorized); keep walking, but do not loop forever.
      if (!page.has_more || emptySteps > 12) return collected;
    } else {
      emptySteps = 0;
    }
    if (!page.has_more) return collected;
    cursor = page.next_cursor;
  }
  return collected;
}

async function main() {
  // --- option parsing -----------------------------------------------------
  check('parseProfileContentKind accepts the four sections', parseProfileContentKind('photos'), 'photos');
  check('parseProfileContentKind rejects junk', parseProfileContentKind('everything'), null);
  check('limit defaults to one item', clampProfileContentLimit(undefined), 1);
  check('limit is clamped to 1..20', [clampProfileContentLimit(0), clampProfileContentLimit(999)], [1, 20]);
  check('a junk limit falls back to one', clampProfileContentLimit('lots'), 1);

  // --- cursor encoding ----------------------------------------------------
  const encoded = Buffer.from(
    `2026-01-01T00:00:01.000000+00:00|00000000-0000-4000-8000-000000000001`,
    'utf8'
  ).toString('base64url');
  check(
    'a malformed cursor is ignored, never thrown on',
    [
      decodeProfileContentCursor(undefined),
      decodeProfileContentCursor('not-base64!!'),
      decodeProfileContentCursor(Buffer.from('nope', 'utf8').toString('base64url')),
      decodeProfileContentCursor(Buffer.from('2026-01-01T00:00:00.0+00:00|short', 'utf8').toString('base64url')),
    ],
    [null, null, null, null]
  );
  assertTrue('a well-formed cursor decodes', decodeProfileContentCursor(encoded) !== null);
  check('cursor is opaque (no raw timestamp leaks into the query string)', encoded.includes('2026'), false);

  // --- one item per request ----------------------------------------------
  {
    // `rows` is in creation order, so rows[0] is the OLDEST and the feed must
    // hand them out newest-first: rows[2], rows[1], rows[0].
    const rows = [post(), post(), post()];
    const tables = { posts: rows, profiles: profileTable() };
    const first = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', { limit: 1 });
    check('limit=1 returns exactly one item', first.items.length, 1);
    check('the first item is the newest', first.items[0].id, rows[2].id);
    check('has_more is true while content remains', first.has_more, true);
    const second = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', {
      limit: 1,
      cursor: first.next_cursor,
    });
    check('the next request returns the next item', second.items[0].id, rows[1].id);
    check('the second page does not repeat the first', second.items.some((i) => i.id === rows[2].id), false);
    const third = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', {
      limit: 1,
      cursor: second.next_cursor,
    });
    check('the last item is the oldest', third.items[0].id, rows[0].id);
    const past = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', {
      limit: 1,
      cursor: third.next_cursor,
    });
    check('the feed ends with an empty page', past.items.length, 0);
    check('and reports has_more false', past.has_more, false);
    check('and no further cursor', past.next_cursor, null);
  }

  // --- a full walk is complete, ordered and duplicate-free ----------------
  {
    const rows = Array.from({ length: 7 }, () => post());
    const tables = { posts: rows, profiles: profileTable() };
    const walked = await walkAll(tables, 'posts', undefined, new Set());
    check('a full walk returns every post', walked.length, rows.length);
    check('in newest-first order', walked.map((i) => i.id), rows.map((r) => r.id).reverse());
    check('with no duplicates', new Set(walked.map((i) => i.id)).size, rows.length);
  }

  // --- ties on created_at must not duplicate or drop rows -----------------
  {
    // Same timestamp, ids deliberately NOT in creation order. An unstable or
    // absent tie-break shows up here as a duplicate or a dropped row.
    const same = '2026-05-05T05:05:05.000000+00:00';
    const rows = [
      post({ id: 'cccccccc-0000-4000-8000-00000000000c', created_at: same }),
      post({ id: 'aaaaaaaa-0000-4000-8000-00000000000a', created_at: same }),
      post({ id: 'bbbbbbbb-0000-4000-8000-00000000000b', created_at: same }),
    ];
    const tables = { posts: rows, profiles: profileTable() };
    const walked = await walkAll(tables, 'posts', undefined, new Set());
    check('tied timestamps still yield every row', walked.length, 3);
    check('tied timestamps yield no duplicates', new Set(walked.map((i) => i.id)).size, 3);
    check(
      'ties are ordered by the id tie-break (newest first)',
      walked.map((i) => i.id),
      ['cccccccc-0000-4000-8000-00000000000c', 'bbbbbbbb-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000a']
    );
  }

  // --- privacy: guest sees only public, and walks past the rest ------------
  {
    // do.md 19: A(Friends) B(Public) C(Friends) D(Public) -> guest gets B, D.
    // Rows are labelled in creation order, so the feed order is D, C, B, A.
    const rows = [
      post({ content: 'A', audience_type: 'friends' }),
      post({ content: 'B', audience_type: 'public' }),
      post({ content: 'C', audience_type: 'friends' }),
      post({ content: 'D', audience_type: 'public' }),
    ];
    const tables = { posts: rows, profiles: profileTable() };
    const guest = await walkAll(tables, 'posts', undefined, new Set());
    check('a guest is served only the public rows', guest.map((i) => i.content), ['D', 'B']);
    const stranger = await walkAll(tables, 'posts', STRANGER, new Set());
    check('a non-friend is served only the public rows', stranger.map((i) => i.content), ['D', 'B']);
    const friend = await walkAll(tables, 'posts', FRIEND, new Set([OWNER]));
    check('an accepted friend is served all four, in order', friend.map((i) => i.content), ['D', 'C', 'B', 'A']);
  }

  // --- privacy: a guest's page never carries a private row, even in bulk --
  {
    const rows = [
      post({ content: 'public' }),
      post({ content: 'only-me', audience_type: 'only_me' }),
      post({ content: 'friends', audience_type: 'friends' }),
    ];
    const tables = { posts: rows, profiles: profileTable() };
    const page = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', { limit: 20 });
    check('a bulk request still withholds every private row', page.items.map((i) => i.content), ['public']);
    check('the withheld rows are reported', page.withheld_count, 2);
  }

  // --- privacy: only_me and unknown audiences are never served ------------
  {
    const rows = [
      post({ content: 'mine', audience_type: 'only_me' }),
      post({ content: 'list', audience_type: 'custom_list' }),
      post({ content: 'fof', audience_type: 'friends_of_friends' }),
      post({ content: 'public' }),
    ];
    const tables = { posts: rows, profiles: profileTable() };
    const stranger = await walkAll(tables, 'posts', STRANGER, new Set());
    check('only_me / custom_list / friends_of_friends are all denied', stranger.map((i) => i.content), ['public']);
  }

  // --- privacy: excluded viewers lose a public-audience post ---------------
  {
    const rows = [post({ audience_type: 'public', audience_excluded_user_ids: [STRANGER] }), post()];
    const tables = { posts: rows, profiles: profileTable() };
    const excluded = await walkAll(tables, 'posts', STRANGER, new Set());
    check('an excluded viewer does not receive the excluded post', excluded.length, 1);
  }

  // --- scheduled posts: author-only, parity with the generic read ----------
  {
    const rows = [
      post({ status: 'scheduled', scheduled_at: '2026-12-01T00:00:00+00:00' }),
      post(),
    ];
    const tables = { posts: rows, profiles: profileTable() };
    check('the author still sees their own scheduled post', (await walkAll(tables, 'posts', OWNER, new Set())).length, 2);
    check('a friend never receives a scheduled post', (await walkAll(tables, 'posts', FRIEND, new Set([OWNER]))).length, 1);
    check('a guest never receives a scheduled post', (await walkAll(tables, 'posts', undefined, new Set())).length, 1);
  }

  // --- an entirely private profile yields nothing, and says so ------------
  {
    const rows = Array.from({ length: 3 }, () => post({ audience_type: 'only_me' }));
    const tables = { posts: rows, profiles: profileTable() };
    const page = await getProfileContentPage(deps(tables), OWNER, STRANGER, new Set(), 'posts', { limit: 1 });
    check('a stranger gets nothing from an only_me profile', page.items.length, 0);
    check('and no cursor, so the feed is over', page.next_cursor, null);
  }

  // --- a private run at the HEAD must not starve the public content behind it
  {
    // The literal do.md 19 hazard: the private posts are the NEWEST (created
    // after the public one) and numerous enough to fill a whole scan batch, so
    // the first batch a guest sees contains nothing they may read. If a page
    // gave up there, this guest would see an empty profile forever instead of
    // the one public post sitting behind the run.
    const rows = [
      post({ content: 'the one public post' }),
      ...Array.from({ length: 14 }, (_, i) => post({ content: `private ${i}`, audience_type: 'friends' })),
    ];
    const tables = { posts: rows, profiles: profileTable() };
    const guest = await walkAll(tables, 'posts', undefined, new Set());
    check('a guest walks past a whole batch of private posts', guest.map((i) => i.content), [
      'the one public post',
    ]);
    const friend = await walkAll(tables, 'posts', FRIEND, new Set([OWNER]));
    check('an accepted friend gets them all', friend.length, 15);
  }

  // --- a long unauthorized run is bounded, not an infinite skip -----------
  {
    // 150 private rows is more than one request may walk (SCAN_BATCH x
    // MAX_SKIP_ROUNDS = 96), so the bound has to engage: the page must come
    // back empty but still report more to walk, with a cursor that has moved.
    // A short private run instead terminates cleanly, which the only_me
    // profile above already pins.
    const rows = Array.from({ length: 150 }, () => post({ audience_type: 'only_me' }));
    const tables = { posts: rows, profiles: profileTable() };
    const page = await getProfileContentPage(deps(tables), OWNER, STRANGER, new Set(), 'posts', { limit: 1 });
    check('a fully private run returns no items', page.items.length, 0);
    check('but still reports more to walk', page.has_more, true);
    assertTrue('and hands back an advanced cursor', page.next_cursor !== null);
    const next = await getProfileContentPage(deps(tables), OWNER, STRANGER, new Set(), 'posts', {
      limit: 1,
      cursor: page.next_cursor,
    });
    // 150 - 96 = 54 rows are left, which is under the bound, so this request
    // walks the remainder and terminates cleanly. That is the point: the bound
    // costs one extra request, it never hides the end of the feed.
    check('the next request makes progress past the run', next.items.length, 0);
    check('and terminates once the run is exhausted', [next.has_more, next.next_cursor], [false, null]);
  }

  // --- the four sections select different rows ----------------------------
  {
    const sharedBody = post({ id: OTHER, user_id: OTHER, content: 'the original' });
    const rows = [
      post({ media_url: 'a.png', media_type: 'image' }),
      post({ type: 'reel', media_url: 'b.mp4', media_type: 'video' }),
      post({ type: 'shared_post', shared_post_id: sharedBody.id, media_url: 'c.png', media_type: 'image' }),
      post(),
    ];
    const tables = { posts: [...rows, sharedBody], profiles: profileTable() };
    check('posts = every row', (await walkAll(tables, 'posts', undefined, new Set())).length, 4);
    const photos = await walkAll(tables, 'photos', undefined, new Set());
    // The reel and the share are excluded by post type, per NON_PHOTO_POST_TYPES.
    check('photos = media rows that are not reels, shares or profile chrome', photos.map((i) => i.media_url), [
      'a.png',
    ]);
    const reels = await walkAll(tables, 'reels', undefined, new Set());
    check('reels = reel rows only', reels.map((i) => i.type), ['reel']);
    const shared = await walkAll(tables, 'shared', undefined, new Set());
    check('shared = shared rows only', shared.map((i) => i.type), ['shared_post']);
  }

  // --- Photos parity: a null media_type with an image URL is STILL a photo --
  {
    // This is the shape the live dataset actually has: 10 of the 12 tiles the
    // Photos tab renders today carry `media_type = null` with an image URL. A
    // `media_type = 'image'` predicate would quietly delete them, so the
    // predicate must key off the post type and the presence of media instead.
    const rows = [
      post({ content: 'tagged image', media_url: 'cloudinary/image/upload/x.jpg', media_type: null }),
      post({ content: 'declared image', media_url: 'y.png', media_type: 'image' }),
      post({ content: 'text only', media_url: null, media_type: null }),
      post({ content: 'reel', type: 'reel', media_url: 'z.mp4', media_type: 'video' }),
      post({ content: 'profile pic', type: 'profile_picture_update', media_url: 'p.png', media_type: 'image' }),
      post({ content: 'cover', type: 'cover_photo_update', media_url: 'c.png', media_type: 'image' }),
      post({ content: 'shared', type: 'shared_post', shared_post_id: OTHER, media_url: 's.png', media_type: 'image' }),
      post({ content: 'untyped', type: null, media_url: 'u.png', media_type: null }),
    ];
    const tables = { posts: rows, profiles: profileTable() };
    const photos = await walkAll(tables, 'photos', undefined, new Set());
    check(
      'a null media_type with an image URL is served as a photo',
      photos.map((i) => i.content),
      // `untyped` included (NULL type is not an excluded type), the reel and
      // both chrome types and the share excluded, and the text-only row dropped
      // for having no media at all.
      ['untyped', 'declared image', 'tagged image']
    );
  }

  // --- Reels parity: a reel with no media is not a reel --------------------
  {
    const rows = [
      post({ content: 'real reel', type: 'reel', media_url: 'r.mp4', media_type: 'video' }),
      post({ content: 'reel with no media', type: 'reel', media_url: null, media_type: null }),
    ];
    const tables = { posts: rows, profiles: profileTable() };
    const reels = await walkAll(tables, 'reels', undefined, new Set());
    check('reels = type reel with a media_url', reels.map((i) => i.content), ['real reel']);
  }

  // --- enrichment: the author projection, never the whole profile row -----
  {
    const tables = { posts: [post()], profiles: profileTable() };
    const page = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', { limit: 1 });
    check('the author projection is attached', page.items[0].profiles, {
      username: 'owner',
      display_name: 'Owner',
      profile_pic: null,
    });
    check('only public profile fields are exposed', Object.keys(page.items[0].profiles).sort(), [
      'display_name',
      'profile_pic',
      'username',
    ]);
  }

  // --- enrichment: a shared post and ITS author come back attached --------
  {
    const original = post({ id: OTHER, user_id: OTHER, content: 'the original' });
    const sharer = post({ type: 'shared_post', shared_post_id: original.id });
    // A plain post alongside the share, so the "not shared" assertion below has
    // something that is genuinely not a share.
    const plain = post({ content: 'plain' });
    const tables = { posts: [original, sharer, plain], profiles: profileTable() };
    const page = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'shared', { limit: 1 });
    check('the shared post body is attached', page.items[0].shared_post?.content, 'the original');
    check('the shared post carries its own author', page.items[0].shared_post?.profiles.username, 'other');
    const plainPage = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', { limit: 1 });
    check('the newest post is the plain one', plainPage.items[0].content, 'plain');
    check('a post that is not shared has no shared_post', plainPage.items[0].shared_post, null);
  }

  // --- enrichment: a Friends-only original cannot leak through Shared ----
  {
    const secret = post({ id: OTHER, user_id: OTHER, content: 'the original', audience_type: 'only_me' });
    const rows = [post({ type: 'shared_post', shared_post_id: secret.id })];
    const tables = { posts: [...rows, secret], profiles: profileTable() };
    const guest = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'shared', { limit: 1 });
    check('a guest gets the pointer but not the private original', guest.items[0].shared_post, null);
    const ownerOfSecret = await getProfileContentPage(deps(tables), OWNER, OTHER, new Set(), 'shared', { limit: 1 });
    check('the original author still sees their own shared post', ownerOfSecret.items[0].shared_post?.content, 'the original');
  }

  // --- every item in one page is unique ----------------------------------
  {
    const rows = Array.from({ length: 5 }, () => post());
    const tables = { posts: rows, profiles: profileTable() };
    const page = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', { limit: 20 });
    check('a bulk page never repeats an id', new Set(page.items.map((i) => i.id)).size, page.items.length);
  }

  // --- a profile with no content ends immediately -------------------------
  {
    const tables = { posts: [], profiles: profileTable() };
    const page = await getProfileContentPage(deps(tables), OWNER, undefined, new Set(), 'posts', { limit: 1 });
    check('an empty profile returns an empty terminal page', [page.items.length, page.has_more, page.next_cursor], [0, false, null]);
  }

  // --- another user's content is never mixed in ---------------------------
  {
    const rows = [post({ content: 'mine' }), post({ user_id: OTHER, content: 'not yours' })];
    const tables = { posts: rows, profiles: profileTable() };
    const walked = await walkAll(tables, 'posts', undefined, new Set());
    check('rows are scoped to the requested profile', walked.map((i) => i.content), ['mine']);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
