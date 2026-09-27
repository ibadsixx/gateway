// Offline regression suite for the public sitemap (do.md "Sitemap/discovery",
// §20). The requirement is not "emit a sitemap" - it is "crawlability is derived
// from the actual content audience and the actual per-entity privacy settings".
// So the interesting assertions are the negative ones: a friends-only / only-me
// / draft / deleted row must not appear, and its ID must not appear anywhere in
// the response, not even in a count or a lastmod. The matrix is the do.md
// "Privacy edge cases" list A-J applied to the sitemap surface, extended to the
// §6-§7 entities.
//
// The source is a fake, which is the point: `SitemapSource` is the only seam
// between the XML builders and the database, so the privacy rules can be
// exercised over a whole corpus without a Supabase project - and so pagination
// can be tested for real, which a handful of live rows never would.
//
// The fake honours the keyset cursor contract exactly as sitemapSource.ts does,
// so a pagination bug in either the builder or the reader shows up here.
//
// Covers §20 items: 3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,19,22.
// (1,2,17,20,21 are route/config concerns -> sitemapRouteTest.ts)
//
// Run: npm run test:sitemap
import assert from 'node:assert/strict';
import {
  buildSitemapChild,
  buildSitemapRoot,
  cursorForRow,
  escapeXml,
  hashtagPath,
  isIndexableGroupRow,
  isIndexableProfileRow,
  isIndexableSitemapRow,
  profileUsernamePath,
  publicContentKind,
  publicContentPath,
  SITEMAP_CURSOR_COLUMN,
  SITEMAP_DATE_ORDERED,
  SITEMAP_MAX_PAGES,
  SITEMAP_PAGE_SIZE,
  SITEMAP_SECTIONS,
  SITEMAP_SECTION_PATH_PREFIX,
  SitemapPageOutOfRange,
  sitemapChildPath,
  type SitemapCursor,
  type SitemapRow,
  type SitemapSection,
  type SitemapSource,
} from './sitemap';

const BASE = 'https://tonesn.vercel.app';
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const post = (n: number, extra: SitemapRow = {}): SitemapRow => ({
  id: uuid(n),
  type: 'normal_post',
  media_type: null,
  created_at: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  audience_type: 'public',
  visibility: 'public',
  status: 'published',
  ...extra,
});

const profile = (n: number, extra: SitemapRow = {}): SitemapRow => ({
  id: uuid(5000 + n),
  username: `user${n}`,
  created_at: `2026-02-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  search_engine_indexing: 'true',
  ...extra,
});

const page = (n: number, extra: SitemapRow = {}): SitemapRow => ({
  id: uuid(6000 + n),
  created_at: `2026-03-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  ...extra,
});

const group = (n: number, extra: SitemapRow = {}): SitemapRow => ({
  id: uuid(7000 + n),
  privacy: 'public',
  created_at: `2026-04-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  ...extra,
});

const hashtag = (tag: string, extra: SitemapRow = {}): SitemapRow => ({
  tag,
  created_at: `2026-05-01T00:00:00.000Z`,
  ...extra,
});

// ---------------------------------------------------------------------------
// A fake that honours the reader's contract: filter in memory, order, then apply
// the keyset cursor. `countOverride` lets a test simulate a head count that
// over-approximates, which is what the real one does.
// ---------------------------------------------------------------------------

function fakeSource(
  corpus: Partial<Record<SitemapSection, SitemapRow[]>>,
  options: { countOverride?: (section: SitemapSection) => number } = {}
): SitemapSource & { calls: Array<{ section: SitemapSection; cursor: SitemapCursor | null; limit: number }> } {
  const calls: Array<{ section: SitemapSection; cursor: SitemapCursor | null; limit: number }> = [];
  const accepted = (section: SitemapSection) =>
    (corpus[section] ?? []).filter((row) => isIndexableSitemapRow(section, row));

  // The same total order the real reader produces.
  const ordered = (section: SitemapSection, rows: SitemapRow[]) => {
    const column = SITEMAP_CURSOR_COLUMN[section];
    const descending = SITEMAP_DATE_ORDERED.has(section);
    return [...rows].sort((a, b) => {
      if (descending) {
        const at = Date.parse(typeof a.created_at === 'string' ? a.created_at : '') || 0;
        const bt = Date.parse(typeof b.created_at === 'string' ? b.created_at : '') || 0;
        if (at !== bt) return bt - at;
      }
      const an = String(a[column] ?? '');
      const bn = String(b[column] ?? '');
      if (an === bn) return 0;
      return descending ? bn.localeCompare(an) : an.localeCompare(bn);
    });
  };

  // True when `row` sorts strictly before `cursor`, i.e. the cursor has already
  // passed it. Mirrors the PostgREST or() the real reader builds.
  const before = (section: SitemapSection, row: SitemapRow, cursor: SitemapCursor) => {
    const column = SITEMAP_CURSOR_COLUMN[section];
    const name = String(row[column] ?? '').trim();
    const key = section === 'hashtags' ? name.toLowerCase() : name;
    if (!SITEMAP_DATE_ORDERED.has(section)) return key <= cursor.name;
    if (!cursor.createdAt) return true;
    const at = Date.parse(typeof row.created_at === 'string' ? row.created_at : '');
    if (Number.isNaN(at)) return true; // unknown date sorts last, i.e. "before" any dated cursor
    const cursorMs = Date.parse(cursor.createdAt);
    if (at !== cursorMs) return at < cursorMs;
    return key <= cursor.name;
  };

  return {
    calls,
    async countSection(section) {
      return options.countOverride ? options.countOverride(section) : accepted(section).length;
    },
    async listSection(section, cursor, limit) {
      calls.push({ section, cursor, limit });
      let rows = accepted(section);
      if (cursor) rows = rows.filter((row) => before(section, row, cursor));
      return ordered(section, rows).slice(0, limit);
    },
  };
}

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

/**
 * §20.3 "XML is valid". A full parser is overkill and a dependency is worse, so
 * this checks the properties a malformed generator actually produces: unbalanced
 * tags, a stray `<` or `&` in text, a bad declaration, a wrong root.
 */
function assertWellFormedXml(xml: string, root: 'urlset' | 'sitemapindex'): void {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'), 'has an XML declaration');
  // Non-global: a /g regex carries lastIndex between exec() calls, so alternating
  // open and close through one instance would desync the parser it is feeding.
  const open = /<([a-z]+)(?:\s[^>]*)?>/;
  const close = /<\/([a-z]+)>/;
  const stack: string[] = [];
  const body = xml.slice(xml.indexOf('\n') + 1);
  for (const token of body.matchAll(/<\/?[a-z]+(?:\s[^>]*)?>/g)) {
    const text = token[0];
    if (text.startsWith('</')) {
      const name = close.exec(text)?.[1] ?? '';
      assert.equal(stack.pop(), name, `tag </${name}> closes the open element`);
    } else {
      stack.push(open.exec(text)?.[1] ?? '');
    }
  }
  assert.equal(stack.length, 0, `every element is closed (left open: ${stack.join(',')})`);
  // A bare `&` or `<` in character data is the other way a hand-built sitemap
  // turns invalid.
  const withoutEntities = body.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, '');
  assert.equal(withoutEntities.includes('&'), false, 'no unescaped & in the document');
  assert.match(body, new RegExp(`<${root}\\s+xmlns="http://www\\.sitemaps\\.org/schemas/sitemap/0\\.9">`),
    `root element is <${root}> with the sitemap namespace`);
}

async function childFor(
  source: SitemapSource,
  section: SitemapSection,
  page: number
): Promise<string[]> {
  const { xml } = await buildSitemapChild(source, { baseUrl: BASE, section, page });
  return locs(xml);
}

async function main(): Promise<void> {
  // =========================================================================
  // URL construction: a sitemap URL must be the one the SPA actually serves
  // =========================================================================
  assert.equal(publicContentKind({ type: 'reel' }), 'reel', 'type=reel is a reel');
  assert.equal(publicContentKind({ type: 'normal_post', media_type: 'image' }), 'photo', 'image media is a photo');
  assert.equal(publicContentKind({ type: 'normal_post', media_type: 'video' }), 'post', 'video post is a post');
  assert.equal(publicContentKind({ type: 'normal_post' }), 'post', 'text post is a post');
  assert.equal(publicContentPath({ id: uuid(1), type: 'normal_post' }), `/post/${uuid(1)}`);
  assert.equal(publicContentPath({ id: uuid(1), type: 'reel' }), `/reel/${uuid(1)}`);
  assert.equal(publicContentPath({ id: uuid(1), type: 'normal_post', media_type: 'image' }), `/photo/${uuid(1)}`);

  // =========================================================================
  // §20.4/§20.8/§20.10 - public Post / Reel / Photo each appear, on their own URL
  // =========================================================================
  const threeSource = fakeSource({
    posts: [post(1)],
    reels: [post(2, { type: 'reel' })],
    photos: [post(3, { media_type: 'image' })],
  });
  const threeRoot = await buildSitemapRoot(threeSource, { baseUrl: BASE });
  assert.equal(threeRoot.shape, 'urlset', 'a 3-URL corpus is served inline, with no index (§13)');
  assertWellFormedXml(threeRoot.xml, 'urlset');
  assert.deepEqual(
    locs(threeRoot.xml).sort(),
    [`${BASE}/photo/${uuid(3)}`, `${BASE}/post/${uuid(1)}`, `${BASE}/reel/${uuid(2)}`].sort(),
    '§20.4/8/10: public post, reel and photo are all listed on their public URLs'
  );

  // A reel is not also a post. Without this the same id would be advertised in
  // sitemap-posts-1.xml AND sitemap-reels-1.xml.
  assert.deepEqual(await childFor(threeSource, 'posts', 1), [`${BASE}/post/${uuid(1)}`],
    'the posts section does not list the reel');
  assert.deepEqual(await childFor(threeSource, 'reels', 1), [`${BASE}/reel/${uuid(2)}`],
    'the reels section does not list the plain post');
  assert.deepEqual(await childFor(threeSource, 'photos', 1), [`${BASE}/photo/${uuid(3)}`],
    'the photos section does not list the plain post');

  // =========================================================================
  // §20.5/§20.6/§20.7 - restricted posts never appear, in any spelling
  // =========================================================================
  const restricted = [
    post(10, { audience_type: 'friends', visibility: 'friends' }),          // §20.5 friends-only
    post(11, { audience_type: 'only_me', visibility: 'only_me' }),          // §20.6 Only Me
    post(12, { visibility: 'friends' }),                                    // legacy column only
    post(13, { audience_type: 'specific', audience_user_ids: [uuid(99)] }),
    post(14, { audience_type: 'custom_list', audience_list_id: uuid(98) }),
    post(15, { audience_type: 'friends_except' }),
    post(16, { audience_type: 'only_me', visibility: 'public' }),           // only_me wins
    post(17, { audience_type: 'friends', visibility: 'public' }),
    post(18, { audience_type: 'public', visibility: 'friends' }),           // columns disagree
    post(19, { audience_type: 'Public', visibility: 'Public' }),            // §2 exact value only
    post(20, { audience_type: 'PUBLIC', visibility: 'PUBLIC' }),
    post(21, { audience_type: 'Everyone', visibility: 'Everyone' }),        // no alias widening
    post(22, { audience_type: 'All', visibility: 'All' }),
    post(23, { audience_type: 'Anyone', visibility: 'Anyone' }),
    post(24, { audience_type: 'public_ish', visibility: 'public_ish' }),
    post(25, { audience_type: 'unpublic', visibility: 'unpublic' }),
    post(26, { audience_type: null, visibility: null }),                    // §20.7 null
    post(27, { audience_type: null, visibility: 'public' }),                // not rescued
    post(28, { audience_type: undefined, visibility: undefined }),          // §20.7 missing
    post(29, { audience_type: 'secret_handshake', visibility: 'secret_handshake' }),
    post(30, { audience_type: 'public', visibility: 'public', status: 'draft' }),
    post(31, { audience_type: 'public', visibility: 'public', status: 'deleted' }),
    post(32, { audience_type: 'public', visibility: 'public', status: 'scheduled' }),
    post(33, { audience_type: 'public', visibility: 'public', status: 'archived' }),
  ];
  for (const row of restricted) {
    assert.equal(isIndexableSitemapRow('posts', row), false,
      `restricted row ${String(row.id)} (${String(row.audience_type)}/${String(row.status)}) is not indexable`);
  }

  // §20.9/§20.11 - private reels and photos, in both content sections.
  for (const row of [post(40, { type: 'reel', audience_type: 'friends', visibility: 'friends' }),
                     post(41, { type: 'reel', audience_type: 'only_me', visibility: 'only_me' })]) {
    assert.equal(isIndexableSitemapRow('reels', row), false, '§20.9: a private reel is not indexable');
  }
  for (const row of [post(42, { media_type: 'image', audience_type: 'friends', visibility: 'friends' }),
                     post(43, { media_type: 'image', audience_type: 'only_me', visibility: 'only_me' })]) {
    assert.equal(isIndexableSitemapRow('photos', row), false, '§20.11: a private photo is not indexable');
  }

  // The strongest form of §20.18: an id must not occur ANYWHERE in the response,
  // not just inside a <loc>.
  const mixed = fakeSource({
    posts: [post(1), ...restricted.filter((r) => r.type !== 'reel' && r.media_type !== 'image')],
    reels: [post(2, { type: 'reel' }), post(40, { type: 'reel', audience_type: 'friends', visibility: 'friends' })],
    photos: [post(3, { media_type: 'image' }), post(42, { media_type: 'image', audience_type: 'only_me', visibility: 'only_me' })],
  });
  const mixedRoot = await buildSitemapRoot(mixed, { baseUrl: BASE });
  for (const row of restricted) {
    assert.equal(mixedRoot.xml.includes(String(row.id)), false,
      `restricted id ${String(row.id)} must not appear anywhere in the sitemap response`);
  }
  // And the accepted rows are all still there: the filter is not just "drop more".
  assert.equal(locs(mixedRoot.xml).length, 3, 'every public row survived alongside 23 restricted ones');

  // =========================================================================
  // §20.12/§20.13 - profiles follow the profile-level search-engine setting
  // =========================================================================
  assert.equal(isIndexableProfileRow(profile(1)), true, '§20.12: an opted-in profile is indexable');
  for (const value of ['false', 'true ', 'TRUE', '1', 'yes', '', null, undefined, 1, true]) {
    assert.equal(isIndexableProfileRow(profile(2, { search_engine_indexing: value })), false,
      `§20.13: search_engine_indexing=${JSON.stringify(value)} does not permit indexing`);
  }
  // The deliberate §6 reading: no setting row at all is NOT permission. The
  // PrivacyCheckup toggle renders off for an absent row, so the product already
  // treats it as "not permitted" and the sitemap must agree.
  const { search_engine_indexing: _absent, ...noSetting } = profile(3);
  assert.equal(isIndexableProfileRow(noSetting), false,
    '§6: a profile that never set the option is not in the sitemap');
  assert.equal(isIndexableProfileRow(profile(3, { search_engine_indexing: undefined })), false,
    'an explicitly-undefined setting is not an opt-in');

  const profileRoot = await buildSitemapRoot(
    fakeSource({ profiles: [profile(1), profile(2, { search_engine_indexing: 'false' }), noSetting] }),
    { baseUrl: BASE }
  );
  assert.deepEqual(locs(profileRoot.xml), [`${BASE}/profile/user1`],
    '§20.12/13: only the opted-in profile URL is advertised');

  // =========================================================================
  // §7 - the other public entities, gated by their own real rules
  // =========================================================================
  // Groups: the same literal the Gateway's guest gate uses.
  assert.equal(isIndexableGroupRow(group(1)), true, 'a public group is indexable');
  for (const privacy of ['private', 'friends', 'Public', 'PUBLIC', null, undefined, '', 'restricted']) {
    assert.equal(isIndexableGroupRow(group(2, { privacy })), false,
      `group privacy ${JSON.stringify(privacy)} is not the public group`);
  }
  // Pages carry no privacy column at all, so only "has a usable id" is gated.
  assert.equal(isIndexableSitemapRow('pages', page(1)), true, 'a page is indexable');
  // Hashtags: public by design, lowercased to match the app's own links.
  assert.equal(isIndexableSitemapRow('hashtags', hashtag('Photography')), true, 'a hashtag is indexable');
  assert.equal(hashtagPath('Photography'), '/hashtag/photography',
    'a tag is lowercased so the sitemap and an internal link are the same URL');

  const otherRoot = await buildSitemapRoot(
    fakeSource({ pages: [page(1)], groups: [group(1), group(2, { privacy: 'private' })], hashtags: [hashtag('Tone'), hashtag('photography')] }),
    { baseUrl: BASE }
  );
  assert.deepEqual(
    locs(otherRoot.xml).sort(),
    [
      `${BASE}/groups/${group(1).id}`,
      `${BASE}/hashtag/photography`,
      `${BASE}/hashtag/tone`,
      `${BASE}/pages/${page(1).id}`,
    ].sort(),
    '§7: pages, public groups and hashtags are listed; a private group is not'
  );

  // =========================================================================
  // Path-segment hygiene: a name that could escape the prefix is not emitted
  // =========================================================================
  for (const bad of ['', '   ', '../../etc/passwd', 'a/b', 'a"b', "x'><script>", 'a b', 'a#b', 'a?b', 'a.b', 'a%2fb', 'ünïcodé', null, undefined, 42, 'x'.repeat(65)]) {
    assert.equal(profileUsernamePath(bad), null, `username ${JSON.stringify(bad)} cannot become a URL`);
    assert.equal(hashtagPath(bad), null, `hashtag ${JSON.stringify(bad)} cannot become a URL`);
  }
  assert.equal(profileUsernamePath('  spaced  '), '/profile/spaced', 'surrounding whitespace is trimmed');
  // Word characters only, because that is exactly what the app parses a mention
  // or hashtag as (`@\w+` / `#\w+` in useMentions.ts / MentionHashtagText.tsx).
  // A dot is excluded on purpose: it is safe in a path segment, but admitting it
  // here would mean the sitemap accepted a name shape the app itself cannot
  // mention, and a name is not worth widening a URL-construction regex for. A
  // rejected username is a missing profile, never a leaked one.
  assert.equal(profileUsernamePath('a_b.C1'), null, 'a dot is outside the app\'s own name shape');
  assert.equal(profileUsernamePath('a_b1'), '/profile/a_b1', 'letters, digits and underscores are allowed');
  assert.equal(hashtagPath('tone_2026'), '/hashtag/tone_2026', 'and so are hashtag names');
  for (const bad of ['', 'not-a-uuid', '../../secret', 'a\nb', null, undefined, 42]) {
    assert.equal(isIndexableSitemapRow('pages', { id: bad as never, created_at: '2026-01-01T00:00:00Z' }), false,
      `page id ${JSON.stringify(bad)} cannot become a URL`);
  }

  // =========================================================================
  // §12 - dates: <lastmod> only when it is a real date
  // =========================================================================
  const badDate = await buildSitemapChild(
    fakeSource({ posts: [post(70, { created_at: 'not-a-date' })] }),
    { baseUrl: BASE, section: 'posts', page: 1 }
  );
  assert.equal(/<lastmod>/.test(badDate.xml), false, '§12: an unparseable created_at emits no <lastmod>');
  assert.equal(badDate.xml.includes(`/post/${uuid(70)}`), true, 'and the URL itself is still listed');
  // A section whose date column is nullable (hashtags) omits it rather than
  // inventing one.
  const nullDate = await buildSitemapChild(
    fakeSource({ hashtags: [hashtag('nope', { created_at: null })] }),
    { baseUrl: BASE, section: 'hashtags', page: 1 }
  );
  assert.equal(/<lastmod>/.test(nullDate.xml), false, '§12: a null created_at emits no <lastmod>');
  const goodDate = await buildSitemapChild(
    fakeSource({ hashtags: [hashtag('yep', { created_at: '2026-05-01T00:00:00.000Z' })] }),
    { baseUrl: BASE, section: 'hashtags', page: 1 }
  );
  assert.match(goodDate.xml, /<lastmod>2026-05-01<\/lastmod>/, '§12: a real date is emitted as a W3C date');
  // Every emitted <lastmod> is a well-formed W3C date - a malformed one would
  // invalidate the whole file.
  assert.equal(/<lastmod>(?![\d-]{10}<\/lastmod>)/.test(mixedRoot.xml), false,
    'every <lastmod> in the document is a well-formed W3C date');

  // =========================================================================
  // §22 - the canonical origin
  // =========================================================================
  assert.equal(threeRoot.xml.includes(`<loc>${BASE}/`), true, '§22: every <loc> uses the canonical origin');
  assert.equal(locs(threeRoot.xml).every((loc) => loc.startsWith(`${BASE}/`)), true,
    '§22: and there is no other origin anywhere');
  // A base with a trailing slash must not produce a doubled separator.
  const slashed = await buildSitemapRoot(threeSource, { baseUrl: 'https://tonesn.vercel.app///' });
  assert.equal(locs(slashed.xml).every((loc) => loc.startsWith(`${BASE}/`)), true,
    'a trailing slash on the base does not leak into the <loc>');

  // =========================================================================
  // §13/§10 - the shape is chosen from the data, and scales
  // =========================================================================
  const small = await buildSitemapRoot(fakeSource({ posts: [post(80)] }), { baseUrl: BASE });
  assert.equal(small.shape, 'urlset', 'a 1-row corpus is a urlset, not a needless index');
  assert.equal(/<sitemapindex/.test(small.xml), false, 'and emits no <sitemap> entries');

  const bigCorpus = Array.from({ length: SITEMAP_PAGE_SIZE * 2 + 5 }, (_, i) => post(1000 + i));
  const big = fakeSource({ posts: bigCorpus });
  const bigRoot = await buildSitemapRoot(big, { baseUrl: BASE });
  assert.equal(bigRoot.shape, 'sitemapindex', '§13: 2005 rows needs an index');
  assert.equal(bigRoot.pageCount, 3, `§10: ${SITEMAP_PAGE_SIZE * 2 + 5} rows -> 3 child sitemaps`);
  assertWellFormedXml(bigRoot.xml, 'sitemapindex');
  assert.deepEqual(locs(bigRoot.xml), [
    `${BASE}${sitemapChildPath('posts', 1)}`,
    `${BASE}${sitemapChildPath('posts', 2)}`,
    `${BASE}${sitemapChildPath('posts', 3)}`,
  ], '§10/§13: children are named /sitemap-<section>-<n>.xml on the canonical origin');
  assert.equal(/<url>/.test(bigRoot.xml), false, 'the index lists <sitemap>, never <url>');
  // §10: each child must itself be valid XML.
  for (const page of [1, 2, 3]) {
    const child = await buildSitemapChild(big, { baseUrl: BASE, section: 'posts', page });
    assertWellFormedXml(child.xml, 'urlset');
  }

  // §20.19 pagination: pages partition the corpus exactly, with no overlap and
  // no gaps, and no page is asked for more than one window of rows.
  const p1 = await childFor(big, 'posts', 1);
  const p2 = await childFor(big, 'posts', 2);
  const p3 = await childFor(big, 'posts', 3);
  assert.equal(p1.length, SITEMAP_PAGE_SIZE, 'page 1 is exactly one window');
  assert.equal(p2.length, SITEMAP_PAGE_SIZE, 'page 2 is exactly one window');
  assert.equal(p3.length, 5, 'page 3 holds the remainder');
  const all = [...p1, ...p2, ...p3];
  assert.equal(new Set(all).size, all.length, '§20.19: no URL appears in two pages');
  assert.equal(new Set(all).size, bigCorpus.length, '§20.19: the pages cover the whole corpus, none lost');
  assert.equal(all.every((loc) => bigCorpus.some((row) => loc.endsWith(`/${row.id}`))), true,
    '§20.19: every listed URL is a real row');
  // The reader is never asked for an unbounded slice.
  assert.equal(big.calls.every((call) => call.limit === SITEMAP_PAGE_SIZE), true,
    '§20.19: the source is only ever asked for one bounded window at a time');
  // Page 1 must not drain the table to return 1000 rows.
  const page1Calls = await (async () => {
    const s = fakeSource({ posts: Array.from({ length: 50_000 }, (_, i) => post(20_000 + i)) });
    await buildSitemapChild(s, { baseUrl: BASE, section: 'posts', page: 1 });
    return s.calls.length;
  })();
  assert.equal(page1Calls, 1, '§20.19: page 1 of a 50k-row table costs ONE query, not 50');

  // A head count is an upper bound, so a section can advertise a tail page that
  // comes back empty. That must be a valid empty urlset, not an error.
  const overCounting = fakeSource(
    { posts: bigCorpus },
    { countOverride: (section) => (section === 'posts' ? SITEMAP_PAGE_SIZE * 5 : 0) }
  );
  const overRoot = await buildSitemapRoot(overCounting, { baseUrl: BASE });
  assert.equal(overRoot.pageCount, 5, 'an over-counting head count widens the index');
  const emptyTail = await buildSitemapChild(overCounting, { baseUrl: BASE, section: 'posts', page: 5 });
  assert.equal(emptyTail.urlCount, 0, 'the advertised tail page is empty');
  assertWellFormedXml(emptyTail.xml, 'urlset');
  assert.equal(locs(emptyTail.xml).length, 0, 'and contains no URLs');

  // An empty corpus is still a valid sitemap, and a section with nothing in it is
  // not advertised at all (no crawl spent on a file that can only be empty).
  const emptyRoot = await buildSitemapRoot(fakeSource({}), { baseUrl: BASE });
  assert.equal(emptyRoot.shape, 'urlset', 'an empty corpus is a urlset');
  assertWellFormedXml(emptyRoot.xml, 'urlset');
  assert.equal(locs(emptyRoot.xml).length, 0, 'with no URLs');
  const onlyEmptySections = await buildSitemapRoot(fakeSource({ posts: [post(90)], groups: [] }), { baseUrl: BASE });
  assert.equal(onlyEmptySections.shape, 'urlset', 'a zero-count section does not force an index');

  // =========================================================================
  // §20.15/§20.16/§20.14 - transitions, re-read per request, nothing cached
  // =========================================================================
  const hRow = post(1000 + 1);
  const restrictedNow: SitemapRow = { ...hRow, audience_type: 'friends', visibility: 'friends' };
  assert.deepEqual(await childFor(fakeSource({ posts: [hRow] }), 'posts', 1), [`${BASE}/post/${hRow.id}`],
    '§20.15/16: listed while public');
  assert.deepEqual(await childFor(fakeSource({ posts: [restrictedNow] }), 'posts', 1), [],
    '§20.15: public -> friends removes the URL on the next generation');
  assert.deepEqual(await childFor(fakeSource({ posts: [hRow] }), 'posts', 1), [`${BASE}/post/${hRow.id}`],
    '§20.16: friends -> public makes it eligible again');
  assert.deepEqual(await childFor(fakeSource({ posts: [] }), 'posts', 1), [],
    '§20.14: a deleted row disappears');

  // A profile opting out is the §14-critical transition, and it must take effect
  // on the very next read - no cached opt-in set.
  assert.deepEqual(await childFor(fakeSource({ profiles: [profile(1)] }), 'profiles', 1), [`${BASE}/profile/user1`],
    '§20.12: the profile is listed while opted in');
  assert.deepEqual(
    await childFor(fakeSource({ profiles: [profile(1, { search_engine_indexing: 'false' })] }), 'profiles', 1),
    [], '§20.13: opting out removes the profile URL immediately, not after a TTL');

  // =========================================================================
  // Child request validation
  // =========================================================================
  for (const bad of [0, -1, 1.5, Number.NaN, SITEMAP_MAX_PAGES + 1]) {
    await assert.rejects(
      () => buildSitemapChild(fakeSource({}), { baseUrl: BASE, section: 'posts', page: bad }),
      SitemapPageOutOfRange,
      `page ${bad} is refused`
    );
  }
  await assert.rejects(
    () => buildSitemapChild(fakeSource({}), { baseUrl: BASE, section: 'secrets' as SitemapSection, page: 1 }),
    SitemapPageOutOfRange,
    'an unknown section is refused rather than queried'
  );

  // =========================================================================
  // Cursor contract
  // =========================================================================
  assert.deepEqual(cursorForRow('posts', { id: uuid(1), created_at: '2026-01-02T03:04:05.678Z' }),
    { createdAt: '2026-01-02T03:04:05.678Z', name: uuid(1) },
    'a post cursor normalizes the date to UTC ISO and lowercases the id');
  assert.deepEqual(cursorForRow('profiles', { username: 'Ada', created_at: '2026-01-02T03:04:05.000Z' }),
    { createdAt: '2026-01-02T03:04:05.000Z', name: 'Ada' },
    'a profile cursor uses the username, and usernames are case-sensitive so it is not lowercased');
  assert.deepEqual(cursorForRow('hashtags', { tag: 'Tone' }), { createdAt: null, name: 'tone' },
    '§11: a hashtag cursor is the tag alone, because hashtags.created_at is nullable');
  assert.deepEqual(cursorForRow('hashtags', { tag: 'tone', created_at: 'garbage' }),
    { createdAt: null, name: 'tone' },
    'an unparseable date becomes a null cursor key rather than a broken filter');

  // =========================================================================
  // §19 - a registered-but-unreadable section fails loudly instead of quietly
  // producing a shorter sitemap
  // =========================================================================
  const failing: SitemapSource = {
    async countSection() { throw new Error('count exploded'); },
    async listSection() { return []; },
  };
  await assert.rejects(() => buildSitemapRoot(failing, { baseUrl: BASE }), /count exploded/,
    '§19: a failing data source surfaces as an error, not as an empty sitemap');

  // =========================================================================
  // XML escaping
  // =========================================================================
  assert.equal(escapeXml(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f', 'all five XML entities escape');
  assert.equal(escapeXml('plain'), 'plain', 'plain text is untouched');
  // The one place user-controlled text could reach the XML is the base URL, and
  // it is escaped on the way in.
  const injected = await buildSitemapRoot(fakeSource({ posts: [post(1)] }), {
    baseUrl: 'https://x.test/"><script>',
  });
  assert.equal(/<script>/.test(injected.xml), false, 'a hostile base URL cannot inject an element');
  assert.equal(injected.xml.includes('&quot;&gt;&lt;script&gt;'), true, 'it is entity-escaped instead');

  // =========================================================================
  // The section table itself is what the route advertises
  // =========================================================================
  assert.deepEqual([...SITEMAP_SECTIONS], ['posts', 'reels', 'photos', 'profiles', 'pages', 'groups', 'hashtags'],
    'the section list is the §3-§7 set, in that order');
  for (const section of SITEMAP_SECTIONS) {
    assert.match(SITEMAP_SECTION_PATH_PREFIX[section], /^\/[a-z]+\/$/,
      `${section} has a single-segment route prefix`);
  }
  assert.equal(sitemapChildPath('posts', 1), '/sitemap-posts-1.xml', 'child path shape matches §10/§13');
  assert.equal(sitemapChildPath('profiles', 12), '/sitemap-profiles-12.xml', 'and is 1-based');

  console.log('sitemapTest: all assertions passed ✓');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
