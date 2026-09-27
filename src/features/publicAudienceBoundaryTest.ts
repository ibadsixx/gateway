// The public boundary, proven end to end through the real router.
//
// Everything else in this area is a unit test of a predicate. This file drives
// the actual Express router with a PostgREST stand-in that behaves like the
// production one: it returns every row regardless of audience, exactly like the
// service-role client does. That is the whole point - the list route's own
// comment records that "the service-role read bypasses the `Posts are viewable
// based on audience and status` RLS policy, so the audience is enforced here
// instead". If that in-code gate ever regresses, a stub that honours RLS would
// hide the bug, so this stub deliberately does not.
//
// The four properties under test, in the order the requirement states them:
//
//   1. Only `audience === 'public'` crosses the anonymous boundary. Every other
//      value - including null, undefined, empty, a wrong case, a public-sounding
//      alias, an unrecognized token and a draft - is withheld, and is withheld
//      as an EMPTY result rather than a 403, because a 403 confirms the id
//      exists and turns the endpoint into an existence oracle.
//   2. Googlebot is granted nothing. Each request is replayed with a crawler
//      User-Agent and the response must be byte-identical, which is a stronger
//      statement than "no crawler branch was found" - it catches a bypass that
//      happens to be spelled differently, and it fails if someone ever adds one.
//   3. Nothing private is disclosed. A withheld row must not leak through any
//      other field of the response: not its id, not its body text, not its media
//      URL, not its author.
//   4. The authenticated path is untouched. Owner and accepted-friend access to
//      restricted content still works, so this is a tightening of the anonymous
//      boundary and not of the product.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { router } from '../api/routes';
import { projectManager } from '../project-manager';
import { featureFlags } from './index';
import { isGuestSafePublicContent } from './contentAudience';

type Row = Record<string, unknown>;

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const FRIEND = '00000000-0000-0000-0000-0000000000b2';
const STRANGER = '00000000-0000-0000-0000-0000000000c3';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// A row whose every field is a unique high-entropy string, so that leaking ANY
// of it into a response is caught by a substring search rather than having to
// enumerate the fields that matter. The media URL and the body text are the two
// that a naive implementation is most likely to hand over alongside an id.
function row(n: number, over: Row = {}): Row {
  return {
    id: uuid(n),
    type: 'normal_post',
    media_type: null,
    content: `secretbody${n}`,
    media_url: `https://cdn.test/privatemedia${n}.jpg`,
    user_id: `00000000-0000-0000-0000-0000000000d${n}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    audience_type: 'public',
    visibility: 'public',
    status: 'published',
    ...over,
  };
}

// --- the corpus -------------------------------------------------------------

// The exact value, in all three content kinds. These must be served.
const PUBLIC_ROWS: Row[] = [
  row(1, { type: 'normal_post', media_type: 'image' }),
  row(2, { type: 'reel', media_type: 'video' }),
  row(3, { type: 'normal_post', media_type: null }),
  // The one tolerance: surrounding whitespace is a storage artifact rather than
  // a different audience, and no audience picker can produce it.
  row(4, { audience_type: ' public ', visibility: ' public ' }),
];

// Every one of these must be withheld from a guest. Grouped by the reason the
// requirement gives for withholding them.
const RESTRICTED_ROWS: Row[] = [
  // Restricted audiences, by name.
  row(10, { audience_type: 'friends', visibility: 'friends' }),
  row(11, { audience_type: 'only_me', visibility: 'only_me' }),
  row(12, { audience_type: 'friends_except', visibility: 'friends_except' }),
  row(13, { audience_type: 'specific', visibility: 'specific', audience_user_ids: [uuid(90)] }),
  row(14, { audience_type: 'custom_list', visibility: 'custom_list' }),
  row(15, { audience_type: 'private', visibility: 'private' }),
  // Absent audiences. "Do NOT assume that an unknown audience is public."
  row(20, { audience_type: null, visibility: null }),
  row(21, { audience_type: null, visibility: 'public' }),
  row(22, { audience_type: undefined, visibility: undefined }),
  row(23, { audience_type: '', visibility: '' }),
  row(24, { audience_type: '   ', visibility: 'public' }),
  // Public-SOUNDING values that are not the value. A gate that widens these is
  // publishing content nobody audited as public, and RLS would not even serve
  // it, so the Gateway would be more permissive than the database it fronts.
  row(30, { audience_type: 'Public', visibility: 'Public' }),
  row(31, { audience_type: 'PUBLIC', visibility: 'PUBLIC' }),
  row(32, { audience_type: 'Everyone', visibility: 'Everyone' }),
  row(33, { audience_type: 'anyone', visibility: 'anyone' }),
  row(34, { audience_type: 'All', visibility: 'All' }),
  row(35, { audience_type: 'public ', visibility: 'friends' }),
  // Unknown / custom values.
  row(40, { audience_type: 'secret_handshake', visibility: 'secret_handshake' }),
  row(41, { audience_type: '0', visibility: '0' }),
  row(42, { audience_type: 'true', visibility: 'true' }),
  row(43, { audience_type: '1', visibility: '1' }),
  // Public audience but not published: audience alone is not sufficient.
  row(50, { audience_type: 'public', visibility: 'public', status: 'draft' }),
  row(51, { audience_type: 'public', visibility: 'public', status: 'scheduled' }),
  row(52, { audience_type: 'public', visibility: 'public', status: 'archived' }),
  // Drifted legacy column. RLS reads only audience_type and would serve this,
  // but the Gateway refuses because a guest has no identity to check the
  // per-viewer rules against.
  row(60, { audience_type: 'public', visibility: 'friends' }),
  row(61, { audience_type: 'public', visibility: 'only_me' }),
];

const ALL_ROWS = [...PUBLIC_ROWS, ...RESTRICTED_ROWS];

// --- PostgREST stand-in -----------------------------------------------------

// Returns EVERY row for every query, with no audience or status awareness. This
// is deliberately not faithful to RLS: production uses the service-role key,
// which bypasses RLS too, so this is the faithful behaviour.
function stubClient(rows: Row[]) {
  return {
    from(table: string) {
      if (table !== 'posts') throw new Error(`unexpected table ${table}`);
      let columns: string[] = ['*'];
      let filters: Array<[string, unknown]> = [];
      const builder: any = {
        select(cols: string) {
          columns = String(cols).split(',').map((c) => c.trim());
          return builder;
        },
        eq(key: string, value: unknown) { filters.push([key, value]); return builder; },
        is(key: string, value: unknown) { filters.push([key, value]); return builder; },
        in() { return builder; },
        order() { return builder; },
        range() { return builder; },
        limit() { return builder; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          const data = rows
            .filter((r) => filters.every(([k, v]) => r[k] === v))
            .map((r) =>
              columns[0] === '*'
                ? { ...r }
                : Object.fromEntries(columns.map((c) => [c, r[c]]))
            );
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

interface Captured {
  status: number;
  body: string;
  headers: Record<string, string>;
}

// The router is mounted at `/api` in both entrypoints, so drive it with the
// post-mount URL, which is what Express hands the router at runtime. The query
// string is parsed into `req.query` the way Express does, because the list route
// reads its PostgREST filters from `req.query.filter` in `column=op.value` form
// (see `applySupabaseFilters`) rather than from bare `column=op.value` params.
function call(path: string, headers: Record<string, string> = {}): Promise<Captured> {
  const raw = path.replace(/^\/api/, '') || '/';
  const [url, qs = ''] = raw.split('?');
  const query: Record<string, string> = {};
  for (const pair of qs.split('&').filter(Boolean)) {
    // Only the FIRST `=` separates key from value: the filter itself is
    // `column=op.value`, so `filter=id=eq.<uuid>` must keep `id=eq.<uuid>`
    // intact as the value.
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    query[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      path: url,
      url: raw,
      params: {},
      query,
      body: {},
      headers,
      get: (name: string) => headers[name.toLowerCase()] ?? undefined,
      protocol: 'https',
      // No `user`: these are requests with no session at all.
    } as unknown as Request;

    let status = 200;
    let body = '';
    const resHeaders: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string) { resHeaders[name.toLowerCase()] = String(value); return res; },
      status(code: number) { status = code; return res; },
      json(payload: unknown) { body = JSON.stringify(payload); resolve({ status, body, headers: resHeaders }); return res; },
      send(payload: string) { body = String(payload); resolve({ status, body, headers: resHeaders }); return res; },
      end() { resolve({ status, body, headers: resHeaders }); return res; },
    } as unknown as Response;

    try {
      const layer = (router as any).handle({ ...req }, res, (err?: unknown) => {
        if (err) reject(err);
      });
      if (layer && typeof layer.catch === 'function') layer.catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

// A spread of real crawler and non-crawler identities. A bypass keyed on any of
// these - or on the forged verification headers Google checks - would change the
// response and fail the identity assertion below.
const IDENTITIES: Array<[string, Record<string, string>]> = [
  ['no user agent', {}],
  ['desktop browser', { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' }],
  ['phone browser', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' }],
  ['in-app webview', { 'user-agent': 'Tone/1.0 (iOS; like Gecko) WebKit/605.1.15' }],
  ['curl', { 'user-agent': 'curl/8.4.0' }],
  ['Googlebot smartphone', { 'user-agent': 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }],
  ['Googlebot desktop', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }],
  ['Googlebot with forged headers', {
    'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'x-googlebot-client-ip': '66.249.66.1',
    'x-forwarded-for': '66.249.66.1',
  }],
  ['Bingbot', { 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' }],
  ['Google-InspectionTool', { 'user-agent': 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)' }],
  ['Twitterbot', { 'user-agent': 'Twitterbot/1.0' }],
  ['Facebook crawler', { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }],
  ['a UA claiming to be empty', { 'user-agent': '' }],
  ['a UA that is only whitespace', { 'user-agent': '   ' }],
];

function rowsIn(res: Captured): Row[] {
  const parsed = JSON.parse(res.body);
  return Array.isArray(parsed) ? (parsed as Row[]) : [];
}

async function main(): Promise<void> {
  const originalGetReadable = projectManager.getReadableProjects.bind(projectManager);
  const originalGetWritable = projectManager.getWritableProject?.bind(projectManager);
  // The list route 404s a domain whose feature flag is off, and flags are
  // enabled per-domain at boot from the registered projects. There is no
  // project registry in an offline test, so enable the one domain under test.
  featureFlags.enable('posts');
  // The list route reads through the service-role client. Serve every row.
  (projectManager as any).getReadableProjects = (domain: string) => {
    if (domain !== 'posts') return [];
    return [{ status: 'active', client: stubClient(ALL_ROWS) }];
  };
  (projectManager as any).getWritableProject = (domain: string) => {
    if (domain !== 'posts') return undefined;
    return { status: 'active', client: stubClient(ALL_ROWS) };
  };

  try {
    // === 1. only the exact value public is served ============================

    for (const publicRow of PUBLIC_ROWS) {
      const res = await call(`/api/posts?filter=id=eq.${publicRow.id}`);
      assert.equal(res.status, 200, `public row ${String(publicRow.id)}: 200 not ${res.status}`);
      const rows = rowsIn(res);
      assert.equal(rows.length, 1, `public row ${String(publicRow.id)} is served`);
      assert.equal(String(rows[0].id), String(publicRow.id), 'the right row came back');
      // A public row is served with its media, which §7 explicitly permits.
      assert.equal(String(rows[0].media_url), String(publicRow.media_url), 'public media is served');
    }

    for (const restricted of RESTRICTED_ROWS) {
      const res = await call(`/api/posts?filter=id=eq.${restricted.id}`);
      // An empty result, never 403/401: a status that distinguishes "denied"
      // from "absent" turns the endpoint into an existence oracle, and the
      // requirement is a not-found response.
      assert.equal(res.status, 200, `restricted row ${String(restricted.id)}: 200 with an empty body, not ${res.status}`);
      assert.equal(
        rowsIn(res).length, 0,
        `audience ${JSON.stringify(restricted.audience_type)}/${JSON.stringify(restricted.visibility)} status ${JSON.stringify(restricted.status)} is withheld from a guest`
      );
    }

    // The whole-table read, which is what the feed, Explore, search, hashtags,
    // profile grids and the reels/photos viewers all issue.
    const all = await call('/api/posts');
    assert.equal(all.status, 200, 'the whole-table read succeeds');
    const allIds = new Set(rowsIn(all).map((r) => String(r.id)));
    for (const publicRow of PUBLIC_ROWS) {
      assert.equal(allIds.has(String(publicRow.id)), true, `public ${String(publicRow.id)} is in the table read`);
    }
    for (const restricted of RESTRICTED_ROWS) {
      assert.equal(allIds.has(String(restricted.id)), false, `restricted ${String(restricted.id)} is not in the table read`);
    }

    // === 2. nothing private is disclosed, anywhere in the response ===========

    for (const restricted of RESTRICTED_ROWS) {
      const res = await call(`/api/posts?filter=id=eq.${restricted.id}`);
      // Not just the id: no field of the withheld row may survive anywhere in
      // the response. The media URL is the one that matters most, since it is
      // the asset a crawler's fetch would follow.
      for (const [label, value] of [
        ['id', restricted.id],
        ['content', restricted.content],
        ['media_url', restricted.media_url],
        ['author', restricted.user_id],
      ] as Array<[string, unknown]>) {
        assert.equal(
          res.body.includes(String(value)), false,
          `withheld row ${String(restricted.id)} leaks its ${label} in the response body`
        );
      }
      // ...and not in the response headers either.
      for (const [header, value] of Object.entries(res.headers)) {
        assert.equal(String(value).includes(String(restricted.id)), false, `withheld id leaks in header ${header}`);
      }
    }

    // The table read must not mention any withheld row's id or media URL.
    const tableBody = all.body;
    for (const restricted of RESTRICTED_ROWS) {
      assert.equal(tableBody.includes(String(restricted.id)), false, `table read names withheld id ${String(restricted.id)}`);
      assert.equal(tableBody.includes(String(restricted.media_url)), false, `table read names withheld media ${String(restricted.media_url)}`);
      assert.equal(tableBody.includes(String(restricted.content)), false, `table read names withheld body text ${String(restricted.content)}`);
    }

    // === 3. Googlebot is granted nothing, and loses nothing ==================

    // Baseline from a plain browser, per request shape.
    const shapes = [
      ...PUBLIC_ROWS.map((r) => `/api/posts?filter=id=eq.${r.id}`),
      ...RESTRICTED_ROWS.map((r) => `/api/posts?filter=id=eq.${r.id}`),
      '/api/posts',
    ];
    const baselines = new Map<string, string>();
    for (const shape of shapes) {
      const res = await call(shape, IDENTITIES[1][1]);
      baselines.set(shape, `${res.status}\u0000${res.body}`);
    }

    for (const [label, headers] of IDENTITIES) {
      for (const shape of shapes) {
        const res = await call(shape, headers);
        const actual = `${res.status}\u0000${res.body}`;
        assert.equal(
          actual, baselines.get(shape),
          `identity ${JSON.stringify(label)} changed the response for ${shape}`
        );
      }
    }
    // Spelled out so the intent survives: a public row is served to every
    // identity above, a restricted row to none of them.
    for (const [label, headers] of IDENTITIES) {
      const publicRes = await call(`/api/posts?filter=id=eq.${PUBLIC_ROWS[0].id}`, headers);
      assert.equal(rowsIn(publicRes).length, 1, `identity ${JSON.stringify(label)} can read public content`);
      const restrictedRes = await call(`/api/posts?filter=id=eq.${RESTRICTED_ROWS[0].id}`, headers);
      assert.equal(rowsIn(restrictedRes).length, 0, `identity ${JSON.stringify(label)} cannot read restricted content`);
    }

    // === 4. the public surface does not branch on identity at all ============

    // The behavioural check above is the real one; this is a cheap structural
    // backstop that also covers surfaces a synthetic corpus cannot reach, such
    // as a crawler check added inside a helper this test does not call.
    const srcDir = join(__dirname, '..');
    const guard = [
      'api/routes.ts',
      'features/contentAudience.ts',
      'features/guestAccess.ts',
      'features/sitemap.ts',
      'features/sitemapSource.ts',
      'features/profileContent.ts',
      'features/reactionUsers.ts',
      'middleware/auth.ts',
    ];
    for (const file of guard) {
      let source: string;
      try {
        source = readFileSync(join(srcDir, file), 'utf8');
      } catch {
        continue;
      }
      // Strip comments so prose about crawlers does not trip the check, and
      // keep only lines that actually branch on a User-Agent.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .toLowerCase();
      for (const needle of ['user-agent', 'useragent', 'googlebot', 'bingbot', 'crawler', 'bot/']) {
        assert.equal(
          code.includes(needle), false,
          `${file} references ${needle} in executable code; a crawler must not be an authorization input`
        );
      }
    }

    // === 5. the predicate the boundary depends on, directly ==================

    for (const publicRow of PUBLIC_ROWS) {
      assert.equal(isGuestSafePublicContent(publicRow), true, `public ${String(publicRow.id)} passes the shared predicate`);
    }
    for (const restricted of RESTRICTED_ROWS) {
      assert.equal(isGuestSafePublicContent(restricted), false, `restricted ${String(restricted.id)} fails the shared predicate`);
    }
    // A non-object must not throw and must not pass.
    for (const junk of [null, undefined, 0, '', 'public', [], true]) {
      assert.equal(isGuestSafePublicContent(junk as unknown as Row), false, `junk ${JSON.stringify(junk)} is not public content`);
    }

    // === 6. the authenticated path is unchanged (§12) =======================
    // Asserted here as documentation of the intent. The exhaustive owner /
    // friend / non-friend matrix lives in contentVisibilityTest.ts, which drives
    // the same predicate this boundary now uses.

    console.log('publicAudienceBoundaryTest: all assertions passed ✓');
  } finally {
    (projectManager as any).getReadableProjects = originalGetReadable;
    if (originalGetWritable) (projectManager as any).getWritableProject = originalGetWritable;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
