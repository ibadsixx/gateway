// End-to-end check of the sitemap HTTP surface, over the real Express router
// with only the database swapped for an in-memory PostgREST stub.
//
// The unit suite (sitemapTest.ts) proves the audience rules. This one proves the
// things that only exist at the route boundary:
//   - the routes are not swallowed by the catch-all `/:domain` router
//   - they are reachable with NO Authorization header at all
//   - a segment that does not exist is a 404, not a 500
//   - a restricted id never appears in any byte of the response
//
// Run: npm run test:sitemap-routes
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { router } from '../api/routes';
import { projectManager } from '../project-manager';

type Row = Record<string, unknown>;

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, over: Row = {}): Row {
  return {
    id: uuid(n),
    type: 'normal_post',
    media_type: null,
    created_at: new Date(Date.UTC(2026, 0, n)).toISOString(),
    audience_type: 'public',
    visibility: 'public',
    status: 'published',
    ...over,
  };
}

// The public rows (listed in the sitemap) and the restricted ones (must not be,
// and must not be nameable from the response).
const PUBLIC_ROWS: Row[] = [
  row(1),
  row(2, { type: 'reel', media_type: 'video' }),
  row(3, { media_type: 'image' }),
  // The one tolerance kept: surrounding whitespace is a storage artifact, not a
  // different audience. A poster can still be crawled and indexed.
  row(4, { audience_type: ' public ', visibility: ' public ' }),
];
const RESTRICTED_ROWS: Row[] = [
  row(10, { audience_type: 'friends', visibility: 'friends' }),
  row(11, { audience_type: 'only_me', visibility: 'only_me' }),
  row(12, { audience_type: 'public', visibility: 'friends' }), // columns disagree -> deny
  row(13, { audience_type: 'public', visibility: 'public', status: 'draft' }),
  row(14, { audience_type: 'specific', audience_user_ids: [uuid(90)] }),
  row(15, { audience_type: 'only_me', visibility: 'public' }), // only_me wins
  // §11: the value must be the exact word `public`. A near-miss spelling is not
  // a decision anybody made, and RLS compares `post_audience_type = 'public'`
  // literally, so these are non-public in the database too.
  row(16, { audience_type: 'Public', visibility: 'Public' }),
  row(17, { audience_type: 'Everyone', visibility: 'Everyone' }),
  row(18, { audience_type: 'All', visibility: 'All' }),
  // A NULL audience is not public, and is not rescued by a public legacy column.
  row(19, { audience_type: null, visibility: null }),
  row(20, { audience_type: null, visibility: 'public' }),
  // An absent audience column entirely.
  row(21, { audience_type: undefined, visibility: undefined }),
];
const ALL_ROWS = [...PUBLIC_ROWS, ...RESTRICTED_ROWS];

// Minimal PostgREST stand-in: understands the `or()` prefilter, the ordering and
// the range window, and nothing else.
function stubClient(rows: Row[]) {
  const matches = (filter: string | null) =>
    rows.filter((r) => {
      if (filter && /status\.is\.null/.test(filter)) {
        if (r.status === null || r.status === undefined) return true;
      }
      if (filter && /status\.eq\.published/.test(filter)) {
        if (r.status === 'published') return true;
      }
      return false;
    });

  return {
    from(table: string) {
      if (table !== 'posts') throw new Error(`unexpected table ${table}`);
      let filter: string | null = null;
      let columns: string[] = [];
      let head = false;
      const ordered = () =>
        [...matches(filter)].sort((a, b) => {
          const at = Date.parse(String(a.created_at)) || 0;
          const bt = Date.parse(String(b.created_at)) || 0;
          if (at !== bt) return bt - at;
          return String(b.id).localeCompare(String(a.id));
        });
      const builder: any = {
        select(cols: string, options?: { head?: boolean }) {
          columns = String(cols).split(',').map((c) => c.trim());
          head = Boolean(options?.head);
          return builder;
        },
        or(value: string) { filter = value; return builder; },
        order() { return builder; },
        range(from: number, to: number) {
          const page = ordered().slice(from, to + 1);
          if (head) return Promise.resolve({ data: null, error: null, count: ordered().length });
          return Promise.resolve({
            data: page.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))),
            error: null,
            count: ordered().length,
          });
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({
            data: ordered().map((r) => Object.fromEntries(columns.map((c) => [c, r[c]]))),
            error: null,
            count: ordered().length,
          }).then(resolve);
        },
      };
      return builder;
    },
  };
}

interface Captured {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
}

// The router is mounted at `/api` in both entrypoints, so drive it with the
// post-mount URL - exactly what Express hands the router at runtime.
function call(method: 'GET', path: string, headers: Record<string, string> = {}): Promise<Captured> {
  const url = path.replace(/^\/api/, '') || '/';
  return new Promise((resolve, reject) => {
    const req = {
      method,
      path: url,
      url,
      params: pathParams(url),
      query: {},
      body: {},
      headers,
      get: (name: string) => headers[name.toLowerCase()] ?? undefined,
      protocol: 'https',
      // No `user`: these routes must work for a caller with no session at all.
    } as unknown as Request;

    let status = 200;
    let body = '';
    const resHeaders: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string) { resHeaders[name.toLowerCase()] = String(value); return res; },
      status(code: number) { status = code; res.statusCode = code; return res; },
      json(payload: unknown) { body = JSON.stringify(payload); resolve({ status, body, contentType: resHeaders['content-type'] ?? '', headers: resHeaders }); return res; },
      send(payload: string) { body = String(payload); resolve({ status, body, contentType: resHeaders['content-type'] ?? '', headers: resHeaders }); return res; },
      end() { resolve({ status, body, contentType: resHeaders['content-type'] ?? '', headers: resHeaders }); return res; },
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

function pathParams(path: string): Record<string, string> {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      params[parts[i].slice(1)] = decodeURIComponent(parts[i + 1] ?? '');
      i++;
    }
  }
  return params;
}

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

async function main(): Promise<void> {
  // Swap in the stub. `getReadableProjects` filters on project status, so the
  // fake project must look active.
  const original = projectManager.getReadableProjects.bind(projectManager);
  (projectManager as any).getReadableProjects = (domain: string) => {
    if (domain !== 'posts') return [];
    return [{ status: 'active', client: stubClient(ALL_ROWS) }];
  };

  try {
    // --- unauthenticated reachability (the crawler has no session) ---
    const index = await call('GET', '/api/sitemap.xml');
    assert.equal(index.status, 200, `sitemap index is reachable with no auth (got ${index.status})`);
    assert.match(index.contentType, /xml/, 'the index is served as XML');
    assert.equal(index.body.includes('<sitemapindex'), true, 'the index is a sitemapindex');
    assert.equal(index.body.includes('/api/sitemap/0.xml'), true, 'segment 0 is advertised');
    // Not swallowed by the catch-all domain router.
    assert.equal(index.body.includes('Not found'), false, 'the index did not fall through to /:domain');

    const seg0 = await call('GET', '/api/sitemap/0.xml');
    assert.equal(seg0.status, 200, 'segment 0 is reachable with no auth');
    assert.equal(seg0.body.includes('<urlset'), true, 'a segment is a urlset');

    // --- §14 A-C are listed; D-G/J are not, and not by name ---
    const listed = locs(seg0.body);
    for (const publicRow of PUBLIC_ROWS) {
      assert.equal(listed.some((loc) => loc.endsWith(`/${publicRow.id}`)), true,
        `public row ${String(publicRow.id)} is listed`);
    }
    for (const restricted of RESTRICTED_ROWS) {
      assert.equal(seg0.body.includes(String(restricted.id)), false,
        `restricted id ${String(restricted.id)} appears nowhere in the response`);
    }

    // --- the URL kind matches the row type ---
    assert.equal(listed.some((loc) => loc.includes(`/post/${uuid(1)}`)), true, 'post URL');
    assert.equal(listed.some((loc) => loc.includes(`/reel/${uuid(2)}`)), true, 'reel URL');
    assert.equal(listed.some((loc) => loc.includes(`/photo/${uuid(3)}`)), true, 'photo URL');

    // --- H/I: audience transitions, on a fresh request each time ---
    const flip = new Map<string, Row>(ALL_ROWS.map((r) => [String(r.id), r]));
    const reread = async () => {
      (projectManager as any).getReadableProjects = () => [{ status: 'active', client: stubClient([...flip.values()]) }];
      return call('GET', '/api/sitemap/0.xml');
    };

    assert.equal(locs((await reread()).body).some((l) => l.endsWith(`/${uuid(1)}`)), true, 'H/I: listed while public');
    flip.set(uuid(1), { ...flip.get(uuid(1))!, audience_type: 'friends', visibility: 'friends' });
    assert.equal(locs((await reread()).body).some((l) => l.endsWith(`/${uuid(1)}`)), false,
      'H: public -> friends removes it from the sitemap');
    flip.set(uuid(1), { ...flip.get(uuid(1))!, audience_type: 'public', visibility: 'public' });
    assert.equal(locs((await reread()).body).some((l) => l.endsWith(`/${uuid(1)}`)), true,
      'I: friends -> public makes it eligible again');
    flip.delete(uuid(1));
    assert.equal(locs((await reread()).body).some((l) => l.endsWith(`/${uuid(1)}`)), false,
      'J: a deleted row disappears');

    // --- bad segment numbers are 404, not 500 ---
    for (const bad of ['/api/sitemap/abc.xml', '/api/sitemap/-1.xml', '/api/sitemap/1e5.xml', '/api/sitemap/999999.xml']) {
      const res = await call('GET', bad);
      assert.equal(res.status, 404, `${bad} is a 404 (got ${res.status})`);
    }
    // A segment beyond the corpus is a valid, empty urlset rather than an error:
    // the index may advertise an empty tail segment.
    const tail = await call('GET', '/api/sitemap/1.xml');
    assert.equal(tail.status, 200, 'a segment past the corpus is a valid empty page');
    assert.equal(locs(tail.body).length, 0, 'and it contains no URLs');

    // --- absolute locs, and a stable cache policy ---
    assert.equal(listed.every((loc) => loc.startsWith('https://') || loc.startsWith('http://')), true,
      'every <loc> is absolute, as the sitemap spec requires');
    assert.match(index.headers['cache-control'] || '', /max-age=\d+/, 'the index is cached briefly, not indefinitely');

    // --- the response carries no row payload at all ---
    assert.equal(seg0.body.includes('audience_type'), false, 'no column names leak into the sitemap');
    assert.equal(seg0.body.toLowerCase().includes('friends'), false, 'no audience values leak into the sitemap');
  } finally {
    (projectManager as any).getReadableProjects = original;
  }

  console.log('sitemapRouteTest: all assertions passed ✓');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
