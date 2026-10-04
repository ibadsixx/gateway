// Post-hashtag-fix, Gateway side: the backfill that reconciles hashtags on
// posts/comments published BEFORE the renderer and Editor-publish fixes.
//
// The bug this exists for was a SWALLOWED failure: `saveHashtags` in the
// frontend wraps everything in a `try/catch` that only `console.error`s, so the
// hashtag registry stayed empty while every publish reported success. So the
// first thing under test here is that this module does NOT repeat that mistake —
// a read failure, a write failure and a partial view must all be REPORTED rather
// than absorbed.
//
// The rest pins the properties that make a backfill safe to run twice against a
// live, sharded database:
//
//   1. Dry run by default. The first call after deploy must size, not mutate.
//   2. Idempotence. Re-running writes nothing the second time.
//   3. Partial-failure safety. A failed tag read must not produce a partial,
//      misleading registry; a failed tag write must not produce an orphan link.
//   4. Shard awareness. `posts`/`comments` live across several projects, so a
//      single client would silently read a fraction of the corpus.
//
// Run: npm run test:hashtag-backfill
import assert from 'node:assert/strict';
import { extractHashtags, isHashtagBackfillAuthorized, parseBackfillDryRun, runHashtagBackfill } from './hashtagBackfill';
import { projectManager } from '../project-manager';

/**
 * A recording stand-in for one Supabase project client. Enough of the query
 * builder for the module's real call sequence (`select().range()`,
 * `upsert().select().single()`, `insert()`), and nothing more — if the module
 * starts using another verb, these tests fail rather than silently pass.
 */
function fakeClient(rows: Record<string, any>[], opts: { failUpsert?: boolean; failInsert?: boolean } = {}) {
  const written: { table: string; op: string; rows: unknown }[] = [];
  const chain: Record<string, any> = {
    select: () => chain,
    upsert: (row: unknown) => {
      if (opts.failUpsert) return { select: () => ({ single: async () => ({ data: null, error: { message: 'rls denied' } }) }) };
      written.push({ table: 'hashtags', op: 'upsert', rows: row });
      const tag = (row as { tag: string }).tag;
      return { select: () => ({ single: async () => ({ data: { id: `id-${tag}` }, error: null }) }) };
    },
    insert: (row: unknown) => {
      if (opts.failInsert) return Promise.resolve({ data: null, error: { message: 'fk violation' } });
      written.push({ table: 'hashtag_links', op: 'insert', rows: row });
      return Promise.resolve({ data: null, error: null });
    },
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
  };
  return { client: { from: () => chain }, written };
}

type Fake = ReturnType<typeof fakeClient>;

/**
 * A shard only has to expose `.client.from()`. `fakeClient` is the full stand-in;
 * the read-failure test deliberately supplies a client that is NOT one (it is
 * typed separately so a missing `written` array cannot be mistaken for one).
 */
type AnyShard = { client: { from(table: string): any } };

/** Point `projectManager` at fakes for the duration of one test. */
function withShards(shards: Record<string, AnyShard[]>, writable?: Record<string, AnyShard>) {
  const original = {
    readable: projectManager.getReadableProjects.bind(projectManager),
    writable: projectManager.getWritableProject.bind(projectManager),
  };
  (projectManager as any).getReadableProjects = (domain: string) =>
    (shards[domain] || []).map((s) => ({ client: s.client }));
  (projectManager as any).getWritableProject = (domain: string) => {
    const found = writable?.[domain];
    return found ? { client: found.client } : null;
  };
  return () => {
    (projectManager as any).getReadableProjects = original.readable;
    (projectManager as any).getWritableProject = original.writable;
  };
}

// --- extraction parity with the frontend ------------------------------------
// `extractHashtags` is duplicated across the two repos (they cannot share a
// module). These cases are the contract; the frontend's
// composerHashtagPersistence.test.ts pins the same ones.

function testExtractionParity(): void {
  assert.deepEqual(extractHashtags('Hello #POV'), ['pov'], '#POV reads as pov');
  assert.deepEqual(extractHashtags('#POV then #pov then #POV again'), ['pov'], 'case variants collapse');
  assert.deepEqual(extractHashtags('#POV and #vlog and #POV'), ['pov', 'vlog'], 'distinct tags stay distinct');
  assert.deepEqual(extractHashtags('no tags here'), [], 'no hashtag yields nothing');
  assert.deepEqual(extractHashtags('a #POV and #vlog caption @alice'), ['pov', 'vlog'], 'mentions are ignored');
  // The tag is stored WITHOUT the '#'. If this ever changes, every stored row
  // and every `.eq('tag', ...)` lookup changes with it.
  assert.ok(!extractHashtags('#POV').some((t) => t.includes('#')), 'the # is stripped');
  console.log('  ok extraction matches the frontend contract');
}

// --- dry run ----------------------------------------------------------------

async function testDryRunByDefault(): Promise<void> {
  const posts = fakeClient([{ id: 'p1', content: '#POV', status: 'published' }]);
  const comments = fakeClient([]);
  const hashtags = fakeClient([]);
  const links = fakeClient([]);
  const restore = withShards(
    { posts: [posts], comments: [comments], hashtags: [hashtags], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const report = await runHashtagBackfill();
    assert.equal(report.dryRun, true, 'dry run unless explicitly opted out');
    assert.equal(report.scanned.posts, 1);
    assert.equal(report.taggedSources, 1);
    assert.deepEqual(report.tagsToCreate, ['pov'], 'reports the tag it would create');
    assert.equal(report.linksToCreate, 1, 'reports the link it would create');
    assert.equal(report.written.tags, 0, 'writes no tags');
    assert.equal(report.written.links, 0, 'writes no links');
    assert.equal(posts.written.length + comments.written.length, 0, 'no writes reach the shards');
    assert.equal(hashtags.written.length, 0, 'no upsert on a dry run');
    assert.equal(links.written.length, 0, 'no insert on a dry run');
    console.log('  ok dry run reports without writing');
  } finally {
    restore();
  }
}

// --- idempotence ------------------------------------------------------------

async function testIdempotent(): Promise<void> {
  const rows = [
    { id: 'p1', content: 'a #POV post', status: 'published' },
    { id: 'p2', content: '#pov and #vlog', status: 'published' },
  ];
  const posts = fakeClient(rows);
  const comments = fakeClient([]);
  const hashtags = fakeClient([]);
  const links = fakeClient([]);
  const restore = withShards(
    { posts: [posts], comments: [comments], hashtags: [hashtags], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const first = await runHashtagBackfill({ dryRun: false });
    assert.equal(first.written.tags, 2, 'creates both missing tags');
    assert.equal(first.written.links, 3, 'creates all three links');
    assert.equal(first.failures.length, 0, 'a clean run reports no failures');

    // Simulate the post-write state and run again: nothing should be written.
    const nowPopulated = fakeClient([
      { id: 'h-pov', tag: 'pov' },
      { id: 'h-vlog', tag: 'vlog' },
    ]);
    const nowLinked = fakeClient([
      { source_type: 'post', source_id: 'p1', hashtag_id: 'h-pov' },
      { source_type: 'post', source_id: 'p2', hashtag_id: 'h-pov' },
      { source_type: 'post', source_id: 'p2', hashtag_id: 'h-vlog' },
    ]);
    const restore2 = withShards(
      { posts: [posts], comments: [comments], hashtags: [nowPopulated], hashtag_links: [nowLinked] },
      { hashtags: nowPopulated, hashtag_links: nowLinked }
    );
    try {
      const second = await runHashtagBackfill({ dryRun: false });
      assert.equal(second.tagsToCreate.length, 0, 'no tags left to create');
      assert.equal(second.linksToCreate, 0, 'no links left to create');
      assert.equal(second.written.tags, 0, 'a second run writes no tags');
      assert.equal(second.written.links, 0, 'a second run writes no links');
      assert.equal(second.tagsExisting, 2, 'reports the tags it found');
      assert.equal(second.linksExisting, 3, 'reports the links it found');
    } finally {
      restore2();
    }
    console.log('  ok a second run is a no-op');
  } finally {
    restore();
  }
}

async function testExistingLinksWithoutAnIdColumn(): Promise<void> {
  // A regression guard for a bug this module actually shipped with in its first
  // draft. `hashtag_links` has NO `id` column: its identity is the
  // (source_type, source_id, hashtag_id) triple, which is what LINKS_SELECT
  // reads. Keying the shard read on `id` — the natural default — drops every
  // link row, `existingLinks` stays empty, and every write run re-inserts the
  // full set. The backfill would look successful on each run and quietly
  // multiply the registry.
  const posts = fakeClient([
    { id: 'p1', content: '#POV', status: 'published' },
    { id: 'p2', content: '#POV', status: 'published' },
  ]);
  const comments = fakeClient([]);
  const hashtags = fakeClient([{ id: 'h-pov', tag: 'pov' }]);
  const links = fakeClient([
    { source_type: 'post', source_id: 'p1', hashtag_id: 'h-pov' },
    { source_type: 'post', source_id: 'p2', hashtag_id: 'h-pov' },
  ]);
  const restore = withShards(
    { posts: [posts], comments: [comments], hashtags: [hashtags], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const report = await runHashtagBackfill({ dryRun: false });
    assert.equal(report.linksExisting, 2, 'both existing links were recognised');
    assert.equal(report.linksToCreate, 0, 'nothing already linked is re-inserted');
    assert.equal(links.written.length, 0, 'no duplicate link row is written');
    console.log('  ok hashtag_links are matched without an id column (no duplicate inserts)');
  } finally {
    restore();
  }
}

// --- loud failure: the whole point ------------------------------------------

async function testWriteFailureIsReported(): Promise<void> {
  const posts = fakeClient([{ id: 'p1', content: '#POV', status: 'published' }]);
  const comments = fakeClient([]);
  const hashtags = fakeClient([], { failUpsert: true });
  const links = fakeClient([]);
  const restore = withShards(
    { posts: [posts], comments: [comments], hashtags: [hashtags], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const report = await runHashtagBackfill({ dryRun: false });
    assert.ok(report.failures.length > 0, 'a failed write is REPORTED, not swallowed');
    assert.equal(report.written.tags, 0, 'nothing claimed as written');
    // The critical half: no link may reference a tag that failed to be created.
    assert.equal(links.written.length, 0, 'no orphan link is written for a failed tag');
    console.log('  ok a failed tag write is reported and creates no orphan link');
  } finally {
    restore();
  }
}

async function testNoWritableProjectIsReported(): Promise<void> {
  const posts = fakeClient([{ id: 'p1', content: '#POV', status: 'published' }]);
  const comments = fakeClient([]);
  const hashtags = fakeClient([]);
  const links = fakeClient([]);
  // Readable but NOT writable — the exact live asymmetry that made this bug
  // invisible: reads succeed, writes have nowhere to go.
  const restore = withShards({
    posts: [posts],
    comments: [comments],
    hashtags: [hashtags],
    hashtag_links: [links],
  });
  try {
    const report = await runHashtagBackfill({ dryRun: false });
    assert.ok(
      report.failures.some((f) => /No writable project/.test(f.detail)),
      'an unwritable hashtags domain is reported'
    );
    assert.equal(report.written.links, 0, 'nothing is written');
    console.log('  ok a readable-but-unwritable domain is reported, not silently skipped');
  } finally {
    restore();
  }
}

async function testReadFailureBlocksWriting(): Promise<void> {
  // A read failure means the diff was computed from an incomplete view. Writing
  // would produce a partial registry that LOOKS complete.
  const posts = fakeClient([{ id: 'p1', content: '#POV', status: 'published' }]);
  const comments = fakeClient([]);
  const hashtags = fakeClient([]);
  const links = fakeClient([]);
  const broken = {
    client: {
      from: () => ({
        select: () => ({
          range: async () => ({ data: null, error: { message: 'connection refused' } }),
        }),
      }),
    },
  };
  const restore = withShards(
    { posts: [posts], comments: [comments], hashtags: [broken], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const report = await runHashtagBackfill({ dryRun: false });
    assert.ok(report.failures.length > 0, 'a read failure is reported');
    assert.equal(hashtags.written.length, 0, 'nothing written when the read was incomplete');
    console.log('  ok a failed read blocks writing instead of writing a partial registry');
  } finally {
    restore();
  }
}

// --- shard awareness --------------------------------------------------------

async function testReadsEveryShard(): Promise<void> {
  // The same tag on three shards must produce one link per source, not just the
  // first shard's. A single-client implementation would under-report by 2/3.
  const a = fakeClient([{ id: 'a1', content: '#POV', status: 'published' }]);
  const b = fakeClient([{ id: 'b1', content: '#POV', status: 'published' }]);
  const c = fakeClient([{ id: 'c1', content: '#POV', status: 'published' }]);
  const comments = fakeClient([]);
  const hashtags = fakeClient([]);
  const links = fakeClient([]);
  const restore = withShards(
    { posts: [a, b, c], comments: [comments], hashtags: [hashtags], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const report = await runHashtagBackfill();
    assert.equal(report.scanned.posts, 3, 'all three shards were read');
    assert.equal(report.taggedSources, 3);
    assert.deepEqual(report.tagsToCreate, ['pov'], 'the tag is created once');
    assert.equal(report.linksToCreate, 3, 'one link per source across shards');
    console.log('  ok every shard is read');
  } finally {
    restore();
  }
}

async function testPaginates(): Promise<void> {
  const many = Array.from({ length: 2500 }, (_, i) => ({
    id: `p${i}`,
    content: `#tag${i % 3}`,
    status: 'published',
  }));
  const posts = fakeClient(many);
  const comments = fakeClient([]);
  const hashtags = fakeClient([]);
  const links = fakeClient([]);
  const restore = withShards(
    { posts: [posts], comments: [comments], hashtags: [hashtags], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const report = await runHashtagBackfill({ pageSize: 1000 });
    assert.equal(report.scanned.posts, 2500, 'paging reads every row, not just the first page');
    assert.deepEqual(report.tagsToCreate, ['tag0', 'tag1', 'tag2']);
    assert.equal(report.linksToCreate, 2500);
    console.log('  ok paging reads every row');
  } finally {
    restore();
  }
}

async function testCommentsIncluded(): Promise<void> {
  const posts = fakeClient([{ id: 'p1', content: 'no tags', status: 'published' }]);
  const comments = fakeClient([{ id: 'c1', content: 'a #POV reply' }]);
  const hashtags = fakeClient([]);
  const links = fakeClient([]);
  const restore = withShards(
    { posts: [posts], comments: [comments], hashtags: [hashtags], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const report = await runHashtagBackfill({ dryRun: false });
    assert.equal(report.scanned.comments, 1);
    assert.equal(report.linksToCreate, 1);
    const link = links.written.find((w) => w.table === 'hashtag_links');
    assert.ok(link, 'a comment link is written');
    assert.deepEqual(link!.rows, {
      source_type: 'comment',
      source_id: 'c1',
      hashtag_id: 'id-pov',
    });
    console.log('  ok comments are backfilled with the right source_type');
  } finally {
    restore();
  }
}

async function testEmptyRegistryIsANoOp(): Promise<void> {
  const posts = fakeClient([{ id: 'p1', content: 'plain caption', status: 'published' }]);
  const comments = fakeClient([{ id: 'c1', content: 'also plain' }]);
  const hashtags = fakeClient([]);
  const links = fakeClient([]);
  const restore = withShards(
    { posts: [posts], comments: [comments], hashtags: [hashtags], hashtag_links: [links] },
    { hashtags, hashtag_links: links }
  );
  try {
    const report = await runHashtagBackfill({ dryRun: false });
    assert.equal(report.taggedSources, 0);
    assert.equal(report.failures.length, 0, 'no hashtag anywhere is not a failure');
    assert.equal(hashtags.written.length + links.written.length, 0);
    console.log('  ok a corpus with no hashtags writes nothing and reports no failures');
  } finally {
    restore();
  }
}

// --- the two gates on the route ---------------------------------------------
// These decide whether a bulk cross-table write can happen at all, so they are
// tested directly rather than only through the HTTP layer. The property that
// matters in both cases is the SAME one: the safe outcome is the default, and
// the dangerous outcome requires an explicit, unambiguous request.

function testAuthorizationGate(): void {
  // Denied when unconfigured — deploying without the env var must not open a
  // write path. This is the failure mode that would be worst to get wrong,
  // because it is invisible until someone uses the endpoint.
  assert.equal(isHashtagBackfillAuthorized(undefined, 'admin-1'), false, 'unset env denies');
  assert.equal(isHashtagBackfillAuthorized('', 'admin-1'), false, 'empty env denies');
  assert.equal(isHashtagBackfillAuthorized('   ', 'admin-1'), false, 'whitespace env denies');
  assert.equal(isHashtagBackfillAuthorized(',,', 'admin-1'), false, 'all-empty env denies');

  // Denied for a caller who is not listed.
  assert.equal(isHashtagBackfillAuthorized('admin-1', 'intruder'), false, 'unlisted caller denied');
  assert.equal(isHashtagBackfillAuthorized('admin-1', ''), false, 'no caller id denied');
  assert.equal(isHashtagBackfillAuthorized('admin-1', undefined), false, 'undefined caller denied');
  assert.equal(isHashtagBackfillAuthorized('admin-1', null), false, 'null caller denied');
  // An empty caller must not match an empty entry, or an unauthenticated
  // request would be authorized by any env containing a blank element.
  assert.equal(isHashtagBackfillAuthorized('admin-1,  ,admin-2', ''), false, 'blank entry grants nothing');

  // Allowed only for an exact match, with whitespace tolerated.
  assert.equal(isHashtagBackfillAuthorized('admin-1', 'admin-1'), true, 'listed caller allowed');
  assert.equal(isHashtagBackfillAuthorized('admin-1,admin-2', 'admin-2'), true, 'second entry allowed');
  assert.equal(isHashtagBackfillAuthorized('admin-1, admin-2', 'admin-2'), true, 'spaces trimmed');
  assert.equal(isHashtagBackfillAuthorized('admin-1', 'admin-10'), false, 'no prefix match');
  assert.equal(isHashtagBackfillAuthorized('admin-1', 'ADMIN-1'), false, 'ids are case-sensitive');
  console.log('  ok the authorization gate denies by default');
}

function testDryRunGate(): void {
  // Only an explicit boolean false opts into writing.
  assert.equal(parseBackfillDryRun({ dryRun: false }), false, 'explicit false writes');
  // Everything else stays a dry run. These are the cases that would otherwise
  // turn a "just check the numbers" call into a full registry mutation.
  assert.equal(parseBackfillDryRun({}), true, 'absent is a dry run');
  assert.equal(parseBackfillDryRun(undefined), true, 'no body is a dry run');
  assert.equal(parseBackfillDryRun(null), true, 'null body is a dry run');
  assert.equal(parseBackfillDryRun({ dryRun: 'false' }), true, 'the string "false" is NOT a write');
  assert.equal(parseBackfillDryRun({ dryRun: 0 }), true, 'zero is NOT a write');
  assert.equal(parseBackfillDryRun({ dryRun: null }), true, 'null is NOT a write');
  assert.equal(parseBackfillDryRun({ dryRun: true }), true, 'true is a dry run');
  assert.equal(parseBackfillDryRun('nonsense'), true, 'a non-object body is a dry run');
  console.log('  ok only an explicit false opts into writing');
}

async function main(): Promise<void> {
  console.log('hashtag backfill');
  testExtractionParity();
  testAuthorizationGate();
  testDryRunGate();
  await testDryRunByDefault();
  await testIdempotent();
  await testExistingLinksWithoutAnIdColumn();
  await testWriteFailureIsReported();
  await testNoWritableProjectIsReported();
  await testReadFailureBlocksWriting();
  await testReadsEveryShard();
  await testPaginates();
  await testCommentsIncluded();
  await testEmptyRegistryIsANoOp();
  console.log('all hashtag backfill tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});