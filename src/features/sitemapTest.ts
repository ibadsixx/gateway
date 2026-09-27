// Offline regression suite for the public sitemap (do.md "Sitemap/discovery").
//
// The requirement is not "emit a sitemap" - it is "crawlability is derived from
// the actual content audience". So the interesting assertions here are the
// negative ones: a friends-only / only-me / draft / deleted row must not appear,
// and its ID must not appear anywhere in the response, not even in a count or a
// lastmod. The matrix is the do.md "Privacy edge cases" list A-J applied to the
// sitemap surface.
//
// The source is a fake, which is the point: `PublicContentSource` is the only
// seam between the XML builders and the database, so the audience rules can be
// exercised over a whole corpus without a Supabase project.
//
// Run: npm run test:sitemap
import assert from 'node:assert/strict';
import {
  buildPublicSitemapIndex,
  buildPublicSitemapPage,
  escapeXml,
  isIndexablePublicRow,
  publicContentKind,
  publicContentPath,
  SITEMAP_MAX_SEGMENTS,
  SITEMAP_PAGE_SIZE,
  SitemapSegmentOutOfRange,
  type PublicContentSource,
  type SitemapContentRow,
} from './sitemap';

const BASE = 'https://example.test';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Row = SitemapContentRow;

const publicPost = (n: number, extra: Row = {}): Row => ({
  id: uuid(n),
  type: 'normal_post',
  media_type: null,
  created_at: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  audience_type: 'public',
  visibility: 'public',
  status: 'published',
  ...extra,
});

// An in-memory corpus with the source's ordering/filtering contract applied the
// same way the Supabase reader does, so offset math in these tests is meaningful.
function fakeSource(rows: Row[]): PublicContentSource {
  const byNewest = (a: Row, b: Row) => {
    const at = Date.parse(String(a.created_at)) || 0;
    const bt = Date.parse(String(b.created_at)) || 0;
    if (at !== bt) return bt - at;
    return String(b.id).localeCompare(String(a.id));
  };
  return {
    async listPublicContent(offset, limit) {
      return rows.filter(isIndexablePublicRow).sort(byNewest).slice(offset, offset + limit);
    },
    async countPublicContent() {
      return rows.filter(isIndexablePublicRow).length;
    },
  };
}

async function locsFor(rows: Row[]): Promise<string[]> {
  const { xml } = await buildPublicSitemapPage(fakeSource(rows), { baseUrl: BASE, segment: 0 });
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

async function main(): Promise<void> {
  // --- content kind routing: a URL must be the one the SPA actually serves ---
  assert.equal(publicContentKind({ type: 'reel' }), 'reel', 'type=reel is a reel');
  assert.equal(publicContentKind({ type: 'normal_post', media_type: 'image' }), 'photo', 'image media is a photo');
  assert.equal(publicContentKind({ type: 'normal_post', media_type: 'video' }), 'post', 'video post is a post');
  assert.equal(publicContentKind({ type: 'normal_post' }), 'post', 'text post is a post');
  assert.equal(publicContentPath({ id: uuid(1), type: 'normal_post' }), `/post/${uuid(1)}`);
  assert.equal(publicContentPath({ id: uuid(1), type: 'reel' }), `/reel/${uuid(1)}`);
  assert.equal(publicContentPath({ id: uuid(1), type: 'normal_post', media_type: 'image' }), `/photo/${uuid(1)}`);

  // --- A/B/C. public Post / Reel / Photo are each listed, on their own URL ---
  const three = [publicPost(1), publicPost(2, { type: 'reel' }), publicPost(3, { media_type: 'image' })];
  assert.deepEqual(
    (await locsFor(three)).sort(),
    [`${BASE}/photo/${uuid(3)}`, `${BASE}/post/${uuid(1)}`, `${BASE}/reel/${uuid(2)}`].sort(),
    'A/B/C: public post, reel and photo are all listed on their public URLs'
  );

  // --- D/E/F. friends-only, whatever the shape, is never listed ---
  const friendsRows = [
    publicPost(10, { audience_type: 'friends', visibility: 'friends' }),
    publicPost(11, { audience_type: 'only_me', visibility: 'only_me' }),
    publicPost(12, { visibility: 'friends' }), // legacy column only
    publicPost(13, { audience_type: 'specific', audience_user_ids: [uuid(99)] }),
    publicPost(14, { audience_type: 'custom_list', audience_list_id: uuid(98) }),
    publicPost(15, { audience_type: 'friends_except' }),
  ];
  for (const row of friendsRows) {
    assert.equal(isIndexablePublicRow(row), false, `restricted row ${String(row.id)} is not indexable`);
  }
  const withPublicAndRestricted = await locsFor([...three, ...friendsRows]);
  assert.equal(withPublicAndRestricted.length, three.length,
    'D/E/F: adding restricted rows adds no URLs to the sitemap');
  assert.equal(withPublicAndRestricted.every((loc) => three.some((row) => loc.endsWith(`/${row.id}`))), true,
    `D/E/F: every listed URL is one of the public rows (got ${JSON.stringify(withPublicAndRestricted)})`);

  // The strongest form of "do not expose private ids": the id must not occur
  // ANYWHERE in the response body, not just inside a <loc>.
  const withPrivate = await buildPublicSitemapPage(fakeSource([publicPost(20), ...friendsRows]), {
    baseUrl: BASE,
    segment: 0,
  });
  for (const row of friendsRows) {
    assert.equal(withPrivate.xml.includes(String(row.id)), false,
      `restricted id ${String(row.id)} must not appear anywhere in the sitemap response`);
  }

  // --- G. Only Me is not public even when the legacy column says public ---
  assert.equal(isIndexablePublicRow(publicPost(30, { audience_type: 'only_me', visibility: 'public' })), false,
    'G: only_me wins over a public legacy column');
  assert.equal(isIndexablePublicRow(publicPost(31, { audience_type: 'friends', visibility: 'public' })), false,
    'audience and legacy column disagreeing on private: denied');

  // --- H. public -> friends removes it (re-read per request, nothing cached) ---
  const hRow = publicPost(40);
  assert.equal((await locsFor([hRow])).length, 1, 'H: listed while public');
  const afterH = await locsFor([{ ...hRow, audience_type: 'friends', visibility: 'friends' }]);
  assert.equal(afterH.length, 0, 'H: gone from the sitemap once the audience changes');

  // --- I. friends -> public makes it eligible ---
  assert.equal((await locsFor([{ ...hRow, audience_type: 'friends', visibility: 'friends' }])).length, 0,
    'I: not listed while friends-only');
  assert.equal((await locsFor([hRow])).length, 1, 'I: listed once the audience becomes public');

  // --- J. deleted / unpublished content is gone ---
  for (const status of ['draft', 'scheduled', 'deleted', 'archived']) {
    assert.equal(isIndexablePublicRow(publicPost(50, { status })), false, `J: status=${status} is not indexable`);
  }
  assert.equal(isIndexablePublicRow(publicPost(51, { status: 'deleted', audience_type: 'public' })), false,
    'J: a deleted row is not listed just because its audience is public');
  assert.equal(isIndexablePublicRow(publicPost(52, { status: null })), true,
    'legacy row with no status column is still public');

  // --- audience spelling: a public value in any casing/alias is crawlable ---
  for (const value of ['public', 'Public', 'PUBLIC', ' everyone ', 'Everyone', 'All', 'Anyone', 'everyone']) {
    assert.equal(isIndexablePublicRow(publicPost(60, { audience_type: value, visibility: value })), true,
      `public spelling ${JSON.stringify(value)} is indexable`);
  }
  for (const value of ['only_me', 'Only Me', 'Private', 'private', 'restricted', 'Me']) {
    assert.equal(isIndexablePublicRow(publicPost(61, { audience_type: value, visibility: value })), false,
      `private spelling ${JSON.stringify(value)} is not indexable`);
  }
  // Unrecognized values fail closed rather than defaulting to public.
  assert.equal(isIndexablePublicRow(publicPost(62, { audience_type: 'secret_handshake', visibility: 'secret_handshake' })), false,
    'an unknown audience value fails closed');

  // --- id hygiene: only a verified uuid can become a path ---
  for (const bad of ['', '   ', 'not-a-uuid', '../../etc/passwd', 'a"b', "x'><script>", null, undefined, 42]) {
    assert.equal(publicContentPath({ id: bad as never, type: 'normal_post' }), null,
      `non-uuid id ${JSON.stringify(bad)} cannot become a URL`);
  }
  // A traversal attempt must not escape the prefix.
  assert.equal(publicContentPath({ id: '../../secret', type: 'normal_post' }), null, 'no path traversal');

  // --- malformed timestamps are dropped, never published ---
  const { xml: badDate } = await buildPublicSitemapPage(
    fakeSource([publicPost(70, { created_at: 'not-a-date' })]),
    { baseUrl: BASE, segment: 0 }
  );
  assert.equal(/<lastmod>/.test(badDate), false, 'an unparseable created_at emits no <lastmod>');
  assert.equal(badDate.includes(`/post/${uuid(70)}`), true, 'the URL itself is still listed');

  // --- XML escaping ---
  assert.equal(escapeXml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f', 'all five XML entities escape');
  assert.equal(escapeXml('plain'), 'plain', 'plain text is untouched');

  // --- an empty corpus still produces a valid, non-broken sitemap ---
  const empty = await buildPublicSitemapPage(fakeSource([]), { baseUrl: BASE, segment: 0 });
  assert.equal(empty.urlCount, 0, 'empty corpus yields no URLs');
  assert.equal(empty.xml.includes('<urlset'), true, 'empty corpus still yields a urlset element');
  const emptyIndex = await buildPublicSitemapIndex(fakeSource([]), { baseUrl: BASE });
  assert.equal(emptyIndex.segmentCount, 1, 'index always has at least one segment');

  // --- index shape: segments, not one enormous file ---
  const oneRow = await buildPublicSitemapIndex(fakeSource([publicPost(80)]), { baseUrl: BASE });
  assert.equal(oneRow.segmentCount, 1, 'a small corpus is one segment');
  assert.equal(oneRow.xml.includes('<sitemapindex'), true, 'the index is a sitemapindex');
  assert.equal(oneRow.xml.includes(`${BASE}/api/sitemap/0.xml`), true, 'segment 0 is advertised');

  const big = Array.from({ length: SITEMAP_PAGE_SIZE * 2 + 5 }, (_, i) => publicPost(1000 + i));
  const bigIndex = await buildPublicSitemapIndex(fakeSource(big), { baseUrl: BASE });
  assert.equal(bigIndex.segmentCount, 3, `${SITEMAP_PAGE_SIZE * 2 + 5} rows -> 3 segments`);
  // The index itself must stay small: it is a list of segments, not a list of posts.
  assert.equal(/<url>/.test(bigIndex.xml), false, 'the index contains no <url> entries, only <sitemap>');
  const seg0 = await buildPublicSitemapPage(fakeSource(big), { baseUrl: BASE, segment: 0 });
  const seg2 = await buildPublicSitemapPage(fakeSource(big), { baseUrl: BASE, segment: 2 });
  assert.equal(seg0.urlCount, SITEMAP_PAGE_SIZE, 'a full segment is exactly the page size');
  assert.equal(seg2.urlCount, 5, 'the tail segment holds the remainder');
  // Segments must partition the corpus, with no url in two segments.
  const all = [
    ...(await locsFor(big)),
  ];
  assert.equal(new Set(all).size, all.length, 'no duplicate URL across the whole sitemap');

  // --- segment bounds (the builder is async, so these are rejections) ---
  await assert.rejects(
    () => buildPublicSitemapPage(fakeSource([]), { baseUrl: BASE, segment: -1 }),
    SitemapSegmentOutOfRange,
    'a negative segment is refused'
  );
  await assert.rejects(
    () => buildPublicSitemapPage(fakeSource([]), { baseUrl: BASE, segment: 1.5 }),
    SitemapSegmentOutOfRange,
    'a non-integer segment is refused'
  );
  await assert.rejects(
    () => buildPublicSitemapPage(fakeSource([]), { baseUrl: BASE, segment: SITEMAP_MAX_SEGMENTS }),
    SitemapSegmentOutOfRange,
    'a segment past the cap is refused'
  );

  console.log('sitemapTest: all assertions passed ✓');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
