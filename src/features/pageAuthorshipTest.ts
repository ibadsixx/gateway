// Offline regression tests for Page-post author attribution.
// Run with: npm run test:page-authorship
//
// A post published as a Page is stored as a `posts` row authored by the admin's
// PERSONAL id plus a `page_posts(page_id, post_id)` link — there is no page
// column. Every generic post read (home feed, /post/:id, Explore, Saved,
// Hashtag, Group, search) used to return only the personal author join, so the
// shared card showed the admin's name and avatar. `attachPageIdentity` resolves
// the owning Page from the existing stable link and attaches it to each linked
// row, leaving personal posts untouched.
//
// The fake below EVALUATES `.in(column, values)` (rather than recording it), so
// these tests exercise the real selection semantics and would fail if the module
// matched on the wrong column (e.g. the author id) or dropped a row.
import assert from 'node:assert/strict';
import {
  attachPageIdentity,
  readPageIdentities,
  readPostPageLinks,
  type PageIdentity,
} from './pageAuthorship';
import type { ReactionProject, ReactionRow } from './reactionUsers';

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error}`);
  }
}

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_PAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A fake `page_posts`/`pages` host that really filters `.in(column, values)`. */
function fakeProject(tables: Record<string, ReactionRow[]>): ReactionProject & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    client: {
      from(table: string) {
        const builder = {
          _column: '' as string,
          _values: [] as string[],
          select(columns: string) {
            queries.push(`${table}.select(${columns})`);
            return builder;
          },
          in(column: string, values: string[]) {
            builder._column = column;
            builder._values = values;
            return builder;
          },
          // PostgREST builders are awaited directly.
          then(resolve: (value: { data: ReactionRow[]; error: null }) => void) {
            const rows = (tables[table] || []).filter((row) =>
              builder._values.includes(String(row[builder._column]))
            );
            resolve({ data: rows, error: null });
          },
        };
        return builder as never;
      },
    },
  };
}

async function main() {
  // --- readPostPageLinks ---
  {
    const pagePosts = fakeProject({
      page_posts: [
        { id: 'l1', page_id: PAGE, post_id: 'post-a', shared_by: ADMIN },
        { id: 'l2', page_id: PAGE, post_id: 'post-b', shared_by: ADMIN },
        { id: 'l3', page_id: OTHER_PAGE, post_id: 'post-c', shared_by: ADMIN },
      ],
    });
    const links = await readPostPageLinks([pagePosts], ['post-a', 'post-c', 'post-zzz']);
    check('readPostPageLinks maps only the requested linked posts', [...links.entries()].sort(), [
      ['post-a', PAGE],
      ['post-c', OTHER_PAGE],
    ]);
    assertTrue('readPostPageLinks queries the page_posts table', pagePosts.queries.some((q) => q.startsWith('page_posts.')));
  }

  // --- readPageIdentities: profile_pic preferred, cover fallback preserved ---
  {
    const pages = fakeProject({
      pages: [
        { id: PAGE, name: 'Tone', cover_image: 'cover.jpg', profile_pic: 'pic.jpg' },
        { id: OTHER_PAGE, name: 'No Pic Page', cover_image: 'cover2.jpg', profile_pic: null },
      ],
    });
    const ids = await readPageIdentities([pages], [PAGE, OTHER_PAGE]);
    check('readPageIdentities resolves name + images by stable id', ids.get(PAGE), {
      id: PAGE,
      name: 'Tone',
      cover_image: 'cover.jpg',
      profile_pic: 'pic.jpg',
    });
    check('a page with no profile_pic keeps a null (card falls back to cover)', ids.get(OTHER_PAGE), {
      id: OTHER_PAGE,
      name: 'No Pic Page',
      cover_image: 'cover2.jpg',
      profile_pic: null,
    });
  }

  // --- attachPageIdentity: a page post gets the page; a personal post does not ---
  {
    const deps = {
      pagePosts: [
        fakeProject({
          page_posts: [{ id: 'l1', page_id: PAGE, post_id: 'post-a', shared_by: ADMIN }],
        }),
      ],
      pages: [
        fakeProject({
          pages: [{ id: PAGE, name: 'Tone', cover_image: 'cover.jpg', profile_pic: 'pic.jpg' }],
        }),
      ],
    };
    const personal: ReactionRow = { id: 'post-p', user_id: ADMIN, content: 'personal' };
    const pagePost: ReactionRow = { id: 'post-a', user_id: ADMIN, content: 'as page' };
    const out = await attachPageIdentity([personal, pagePost], deps);

    check('the page post carries the page identity', out[1].page, {
      id: PAGE,
      name: 'Tone',
      cover_image: 'cover.jpg',
      profile_pic: 'pic.jpg',
    } as PageIdentity);
    check('the personal post has no page key', 'page' in out[0], false);
    check('the personal row is returned by the same reference (untouched)', out[0] === personal, true);
    check('the author id is preserved for auth/ownership', out[1].user_id, ADMIN);
  }

  // --- attachPageIdentity: page attribution is derived from the LINK, never
  //     from a name/username/image or the author id ---
  {
    const deps = {
      pagePosts: [fakeProject({ page_posts: [] })],
      pages: [
        fakeProject({
          pages: [{ id: PAGE, name: 'Tone', cover_image: null, profile_pic: null }],
        }),
      ],
    };
    // A post whose author happens to share the page's name must NOT be attributed.
    const out = await attachPageIdentity([{ id: 'post-x', user_id: PAGE, content: 'Tone' }], deps);
    check('a post with no page_posts link is never attributed by name/author', 'page' in out[0], false);
  }

  // --- fail-open: a broken/empty page_posts read leaves rows unchanged ---
  {
    const broken: ReactionProject = {
      client: {
        from: () => ({
          select: () => ({
            in: () => ({
              then: (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'down' } }),
            }),
          }),
        }),
      },
    };
    const rows: ReactionRow[] = [{ id: 'post-a', user_id: ADMIN }];
    const out = await attachPageIdentity(rows, { pagePosts: [broken], pages: [] });
    check('a failed page_posts read leaves the row unchanged (fail-open)', out[0] === rows[0], true);
    check('no page key added when attribution cannot be resolved', 'page' in out[0], false);
  }

  // --- a shared post embeds the page identity of the ORIGINAL post ---
  {
    const deps = {
      pagePosts: [
        fakeProject({
          page_posts: [{ id: 'l1', page_id: PAGE, post_id: 'orig-a', shared_by: ADMIN }],
        }),
      ],
      pages: [
        fakeProject({
          pages: [{ id: PAGE, name: 'Tone', cover_image: 'cover.jpg', profile_pic: 'pic.jpg' }],
        }),
      ],
    };
    const share: ReactionRow = {
      id: 'share-1',
      user_id: ADMIN,
      type: 'shared_post',
      shared_post: { id: 'orig-a', user_id: ADMIN, content: 'as page' },
    };
    const [out] = await attachPageIdentity([share], deps);
    check('the share row itself is not attributed to the page', 'page' in out, false);
    check('the embedded original post carries the page', (out.shared_post as ReactionRow).page, {
      id: PAGE,
      name: 'Tone',
      cover_image: 'cover.jpg',
      profile_pic: 'pic.jpg',
    } as PageIdentity);
    check('the embedded original post keeps its id', (out.shared_post as ReactionRow).id, 'orig-a');
  }

  // --- a page that cannot be resolved adds nothing (no half-attribution) ---
  {
    const deps = {
      pagePosts: [fakeProject({ page_posts: [{ id: 'l1', page_id: PAGE, post_id: 'post-a' }] })],
      pages: [], // pages domain unavailable
    };
    const out = await attachPageIdentity([{ id: 'post-a', user_id: ADMIN }], deps);
    check('an unresolvable page adds no page key', 'page' in out[0], false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function assertTrue(name: string, value: boolean) {
  check(name, value, true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
