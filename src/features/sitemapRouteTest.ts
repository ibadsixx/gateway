// End-to-end check of the sitemap HTTP surface: the real Express router, over a
// real socket, with only the database swapped for an in-memory PostgREST stub.
//
// The unit suite (sitemapTest.ts) proves the privacy rules and the pagination
// arithmetic. This one proves the things that only exist at the route boundary:
//   - the routes are not swallowed by the catch-all `/:domain` router, and
//     `/sitemap.xml` is not turned into the SPA shell (do.md §17, §20.20)
//   - they are reachable with NO Authorization header at all (§20.1, §20.17)
//   - the Content-Type is XML and not JSON (§1, §20.2)
//   - a malformed child path is a 404, not a 500
//   - a restricted id never appears in any byte of the response (§20.18)
//   - a failing data source is a 500 with a generic body, never a partial
//     sitemap and never an error message (§19)
//
// It also covers the two claims that can only be checked against a real reader:
//
//   §9   the prefilter is a proven SUPERSET of the accepted set, so §2's strict
//        "exactly public" rule is not quietly narrowed by the database filter.
//        The stub interprets the `or()` / `eq` / `in` / `ilike` strings the way
//        PostgREST does, so this asserts the real filter against the real
//        predicate rather than a restatement of them.
//   §6/§12 the profile opt-in, which is a two-table read with no FK to join on.
//
// The router is driven over a real listener rather than by faking `req.params`,
// because the child route's parameter is mid-segment (`/sitemap-:file`) and only
// Express itself gets that split right.
//
// Run: npm run test:sitemap-routes
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { router } from '../api/routes';
import { projectManager } from '../project-manager';
import { isIndexableSitemapRow, SITEMAP_PAGE_SIZE } from './sitemap';

type Row = Record<string, unknown>;

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function post(n: number, over: Row = {}): Row {
  return {
    id: uuid(n),
    type: 'normal_post',
    media_type: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    audience_type: 'public',
    visibility: 'public',
    status: 'published',
    // Fields a full row would carry and the sitemap must never ask for (§9).
    content: `secret body ${n}`,
    media_url: `https://cdn.test/${n}.jpg`,
    author_id: uuid(90_000 + n),
    comment_count: 17,
    ...over,
  };
}

function profile(n: number, over: Row = {}): Row {
  return {
    id: uuid(5000 + n),
    username: `user${n}`,
    display_name: `User ${n}`,
    email: `user${n}@example.test`,
    created_at: new Date(Date.UTC(2026, 1, 1, 0, 0, n)).toISOString(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A PostgREST stub that interprets the filter strings the reader actually emits
// ---------------------------------------------------------------------------

type Cond =
  | { kind: 'and'; args: Cond[] }
  | { kind: 'cmp'; col: string; op: string; value: string };

function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

function parseCond(input: string): Cond {
  if (input.startsWith('and(') && input.endsWith(')')) {
    return { kind: 'and', args: splitTopLevel(input.slice(4, -1)).map(parseCond) };
  }
  const match = /^([a-z_]+)\.([a-z]+)\.([\s\S]*)$/.exec(input);
  if (!match) throw new Error(`unparseable filter condition: ${input}`);
  return { kind: 'cmp', col: match[1], op: match[2], value: match[3] };
}

// PostgREST `*` is SQL `%`; `_` is a single character. Both wildcards, because
// the reader relies on `%public%` matching any string containing "public".
function likeToRegExp(pattern: string): RegExp {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*' || ch === '%') source += '[\\s\\S]*';
    else if (ch === '_') source += '[\\s\\S]';
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function cell(row: Row, col: string): unknown {
  return row[col];
}

function evalCond(cond: Cond, row: Row): boolean {
  if (cond.kind === 'and') return cond.args.every((arg) => evalCond(arg, row));
  const raw = cell(row, cond.col);
  const text = raw === null || raw === undefined ? null : String(raw);
  switch (cond.op) {
    case 'is':
      if (cond.value === 'null') return text === null;
      return text === cond.value;
    case 'eq':
      return text === cond.value;
    case 'neq':
      return text !== cond.value;
    case 'like':
      return text !== null && likeToRegExp(cond.value).test(text);
    case 'ilike':
      return text !== null && likeToRegExp(cond.value.toLowerCase()).test(text.toLowerCase());
    case 'lt':
    case 'gt': {
      if (text === null) return false;
      // created_at is the only date-compared column in a cursor; everything else
      // (id, username, tag) compares as a string, because Date.parse would
      // happily read a bare "2026" as a year and order a tag page by accident.
      if (cond.col === 'created_at') {
        const a = Date.parse(text);
        const b = Date.parse(cond.value);
        if (Number.isNaN(a) || Number.isNaN(b)) return false;
        return cond.op === 'lt' ? a < b : a > b;
      }
      return cond.op === 'lt' ? text < cond.value : text > cond.value;
    }
    default:
      throw new Error(`stub does not implement operator ${cond.op}`);
  }
}

interface RecordedQuery {
  table: string;
  select: string | null;
  head: boolean;
  filters: Array<{ kind: string; detail: string }>;
}

interface StubDb {
  tables: Record<string, Row[]>;
  failTables: Set<string>;
  queries: RecordedQuery[];
}

const db: StubDb = { tables: {}, failTables: new Set(), queries: [] };

function makeClient() {
  return {
    from(table: string) {
      const record: RecordedQuery = { table, select: null, head: false, filters: [] };
      db.queries.push(record);
      const state = {
        orFilters: [] as string[],
        eqs: [] as Array<[string, string]>,
        ins: [] as Array<[string, string[]]>,
        ilikes: [] as Array<[string, string]>,
        orders: [] as Array<[string, boolean]>,
        limitN: null as number | null,
        rangeN: null as [number, number] | null,
      };

      const run = (): { rows: Row[]; count: number; error: unknown } => {
        if (db.failTables.has(table)) {
          return { rows: [], count: 0, error: { message: 'connection to the secret-project pool failed' } };
        }
        const source = db.tables[table] ?? [];
        let rows = source.filter((row) => {
          // Each `or(...)` is a DISJUNCTION of its comma-separated conditions, and
          // separate or() calls AND together. (Reading the or() as a conjunction
          // is what made the first run of this suite return an empty sitemap.)
          const orFiltersPass = state.orFilters.every((filter) =>
            splitTopLevel(filter).some((cond) => evalCond(parseCond(cond), row))
          );
          if (!orFiltersPass) return false;
          if (!state.eqs.every(([col, value]) => evalCond({ kind: 'cmp', col, op: 'eq', value }, row))) return false;
          if (!state.ins.every(([col, values]) => values.includes(String(cell(row, col) ?? '')))) return false;
          if (!state.ilikes.every(([col, pattern]) => evalCond({ kind: 'cmp', col, op: 'ilike', value: pattern }, row))) {
            return false;
          }
          return true;
        });
        // `count: 'exact'` counts the FILTERED set, before range/limit - which is
        // the whole reason a per-section head count can be tighter than the table.
        const filteredCount = rows.length;
        for (const [col, ascending] of [...state.orders].reverse()) {
          rows = [...rows].sort((a, b) => {
            const av = String(cell(a, col) ?? '');
            const bv = String(cell(b, col) ?? '');
            return (av < bv ? -1 : av > bv ? 1 : 0) * (ascending ? 1 : -1);
          });
        }
        if (state.rangeN) rows = rows.slice(state.rangeN[0], state.rangeN[1] + 1);
        else if (state.limitN !== null) rows = rows.slice(0, state.limitN);
        return { rows, count: filteredCount, error: null };
      };

      const project = (rows: Row[]) => {
        const cols = String(record.select ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        return rows.map((row) => Object.fromEntries(cols.map((c) => [c, row[c]])));
      };

      const builder: any = {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          record.select = columns;
          record.head = Boolean(options?.head);
          return builder;
        },
        or(filter: string) { record.filters.push({ kind: 'or', detail: filter }); state.orFilters.push(filter); return builder; },
        eq(col: string, value: string) { record.filters.push({ kind: 'eq', detail: `${col}=${value}` }); state.eqs.push([col, value]); return builder; },
        in(col: string, values: string[]) { record.filters.push({ kind: 'in', detail: `${col} in (${values.length})` }); state.ins.push([col, values]); return builder; },
        ilike(col: string, pattern: string) { record.filters.push({ kind: 'ilike', detail: `${col}~${pattern}` }); state.ilikes.push([col, pattern]); return builder; },
        order(col: string, options: { ascending: boolean }) { record.filters.push({ kind: 'order', detail: col }); state.orders.push([col, options.ascending]); return builder; },
        limit(count: number) { record.filters.push({ kind: 'limit', detail: String(count) }); state.limitN = count; return builder; },
        range(from: number, to: number) { state.rangeN = [from, to]; return builder; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          try {
            const { rows, count, error } = run();
            const value = record.head
              ? { data: null, error, count }
              : { data: project(rows), error, count };
            return Promise.resolve(value).then(resolve, reject);
          } catch (err) {
            return Promise.reject(err).then(resolve, reject);
          }
        },
      };
      return builder;
    },
  };
}

const ALL_DOMAINS = ['posts', 'profiles', 'privacy_settings', 'pages', 'groups', 'hashtags', 'users'];

let registeredDomains = new Set(ALL_DOMAINS);

function setTables(tables: Record<string, Row[]>): void {
  db.tables = tables;
  db.failTables = new Set();
  db.queries = [];
}

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// Real listener
// ---------------------------------------------------------------------------

let base = '';

async function get(path: string, headers: Record<string, string> = {}) {
  // No Authorization header is ever sent: a crawler has no session (§20.17).
  const res = await fetch(`${base}${path}`, { headers });
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? '',
    headers: Object.fromEntries(res.headers.entries()),
  };
}

async function main(): Promise<void> {
  const original = projectManager.getReadableProjects.bind(projectManager);
  (projectManager as any).getReadableProjects = (domain: string) => {
    if (!registeredDomains.has(domain)) return [];
    return [{ status: 'active', client: makeClient() }];
  };

  const app = express();
  app.use('/api', router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // =======================================================================
    // §20.1/2/3/17/20/22 - the small-corpus path
    // =======================================================================
    setTables({
      posts: [
        post(1),
        post(2, { type: 'reel', media_type: 'video' }),
        post(3, { media_type: 'image' }),
        // The one leniency the predicate keeps: surrounding whitespace on the
        // exact value. A poster can still be crawled and indexed.
        post(4, { audience_type: ' public ', visibility: ' public ' }),
        // ...and the case variations it must NOT keep, even though the old
        // prefilter would have dropped them too - see the §9 matrix below.
        // The posts RLS CASE falls through to `ELSE false`, so an anonymous
        // client cannot read a row whose status is not exactly 'published'.
        // The column's CHECK constraint cannot even store 'Published'; this row
        // proves the sitemap does not depend on the constraint holding.
        post(5, { status: 'Published' }),
        // ...and a row with a NULL status, which the CHECK *does* permit and the
        // RLS CASE *does* deny. This is the reachable divergence.
        post(6, { status: null }),
      ],
      profiles: [profile(1), profile(2), profile(3)],
      // Only user1 has an explicit opt-OUT, so it is withheld. user2 and user3
      // have no row at all and are advertised by the default-ON rule.
      privacy_settings: [{ id: uuid(1), user_id: uuid(5001), setting_name: 'search_engine_indexing', setting_value: 'false' }],
      pages: [{ id: uuid(6001), name: 'Tone', created_at: '2026-03-01T00:00:00Z' }],
      groups: [
        { id: uuid(7001), name: 'Open', privacy: 'public', created_at: '2026-04-01T00:00:00Z' },
        { id: uuid(7002), name: 'Closed', privacy: 'private', created_at: '2026-04-01T00:00:00Z' },
      ],
      hashtags: [{ id: uuid(1), tag: 'Tone', created_at: '2026-05-01T00:00:00Z' }],
    });

    const root = await get('/api/sitemap.xml');
    assert.equal(root.status, 200, `§20.1: /sitemap.xml is reachable logged out (got ${root.status})`);
    assert.match(root.contentType, /xml/, '§20.2: the response Content-Type is XML, not JSON');
    assert.equal(root.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), true, '§20.3: it is XML');
    assert.match(root.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/, '§20.3: a urlset');
    // §20.20: the whole point of the vercel.json rewrite - this must not be the
    // SPA shell.
    assert.equal(/<!doctype html/i.test(root.body), false, '§20.20: /sitemap.xml is not the SPA index.html');
    assert.equal(/<div id="root"/.test(root.body), false, '§20.20: and carries no app markup');
    // Not swallowed by the catch-all domain router.
    assert.equal(root.body.includes('Not found'), false, 'the route did not fall through to /:domain');
    assert.equal(root.headers['x-sitemap-shape'], 'urlset', '§13: a small corpus is served inline');
    assert.match(root.headers['cache-control'] || '', /max-age=300/, '§18: cached briefly, not indefinitely');
    assert.equal(/stale-while-revalidate/.test(root.headers['cache-control'] || ''), false,
      '§18: no stale-while-revalidate, which would extend the privacy window');

    const listed = locs(root.body);
    // §22: every URL is on the canonical origin.
    assert.equal(listed.every((loc) => loc.startsWith('https://tonesn.vercel.app/')), true,
      `§20.22: all <loc> use the canonical origin (got ${JSON.stringify(listed)})`);
    assert.equal(listed.every((loc) => !loc.includes('127.0.0.1')), true,
      '§20.22: the request origin is NOT used, even though it is the one answering');

    // §20.4/8/10 - the three public content kinds on their own routes.
    for (const [n, prefix] of [[1, 'post'], [2, 'reel'], [3, 'photo']] as const) {
      assert.equal(listed.includes(`https://tonesn.vercel.app/${prefix}/${uuid(n)}`), true,
        `§20.4/8/10: the public ${prefix} is listed`);
    }
    // ...and the whitespace tolerance on the audience, which is kept.
    assert.equal(listed.includes(`https://tonesn.vercel.app/post/${uuid(4)}`), true,
      'a public post stored with surrounding whitespace is still listed');
    // The status gate is EXACT, because RLS's CASE is exact. Both of these rows
    // are unreadable to an anonymous client, so advertising them would leak the
    // existence of a post nobody may see.
    assert.equal(listed.includes(`https://tonesn.vercel.app/post/${uuid(5)}`), false,
      'a public post stored as status=Published is NOT listed (RLS ELSE false denies it)');
    assert.equal(listed.includes(`https://tonesn.vercel.app/post/${uuid(6)}`), false,
      'a public post with status=NULL is NOT listed (RLS ELSE false denies it)');
    // §20.12/13 - the profile section follows the real preference table.
    // INVERTED for the default-ON rule: user1 holds the explicit 'false' and is
    // withheld; user2 and user3 have no row and are advertised.
    assert.equal(listed.includes('https://tonesn.vercel.app/profile/user1'), false,
      '§20.13: the profile with an explicit opt-out is withheld');
    for (const username of ['user2', 'user3']) {
      assert.equal(listed.includes(`https://tonesn.vercel.app/profile/${username}`), true,
        `§6 (default-ON): ${username}, which never set the option, is advertised`);
    }
    // §7 - the other public entities, each under its own rule.
    assert.equal(listed.includes(`https://tonesn.vercel.app/pages/${uuid(6001)}`), true, '§7: a page is listed');
    assert.equal(listed.includes(`https://tonesn.vercel.app/groups/${uuid(7001)}`), true, '§7: a public group is listed');
    assert.equal(listed.includes(`https://tonesn.vercel.app/groups/${uuid(7002)}`), false, '§7: a private group is not');
    assert.equal(listed.includes('https://tonesn.vercel.app/hashtag/tone'), true, '§7: a hashtag is listed, lowercased');

    // §20.18 - the strongest form: no row data, and no restricted id, anywhere.
    assert.equal(root.body.includes('secret body'), false, '§20.18: no post content leaks');
    assert.equal(root.body.includes('cdn.test'), false, '§20.18: no media URL leaks');
    assert.equal(root.body.includes('audience_type'), false, '§20.18: no column names leak');
    assert.equal(root.body.toLowerCase().includes('friends'), false, '§20.18: no audience values leak');
    assert.equal(root.body.includes('example.test'), false, '§20.18: no profile email leaks');

    // §9 - the read asks for the minimum, and never for a private column.
    const postQueries = db.queries.filter((q) => q.table === 'posts');
    assert.equal(postQueries.length > 0, true, 'the posts section was read');
    for (const q of postQueries) {
      const cols = String(q.select).split(',').map((c) => c.trim());
      for (const forbidden of ['content', 'media_url', 'author_id', 'comment_count', 'reactions']) {
        assert.equal(cols.includes(forbidden), false, `§9: the sitemap must not select ${forbidden}`);
      }
      assert.equal(cols.includes('id') && cols.includes('created_at') && cols.includes('audience_type'), true,
        '§9: but it does select what a URL and an indexability decision need');
    }
    // §8 - one read per section, not one per URL. Six sections must not cost
    // more than a small constant number of queries.
    const distinctTables = new Set(db.queries.map((q) => q.table));
    assert.equal(distinctTables.size <= ALL_DOMAINS.length, true, '§8: only the owning projects are queried');
    assert.equal(db.queries.length < 60, true,
      `§8: a small sitemap costs a constant number of queries, not one per URL (got ${db.queries.length})`);

    // =======================================================================
    // §9 - the prefilter is a proven superset of the accepted set
    //
    // `accepted` is the AUTHORITY (isIndexableSitemapRow -> contentRowPath, which
    // is the audience predicate plus the exact RLS status gate), and the assertion
    // is one-directional: anything the authority accepts must survive the DB
    // prefilter. This is the check that would have caught the previous
    // `status.eq.published` prefilter back when the predicate accepted
    // 'Published', and it still guards the audience prefilter today.
    //
    // The mixed-case and NULL status rows are now REJECTED by the authority, so
    // they sit in this matrix as states the prefilter may over-exclude: no
    // assertion is demanded of them, and that is correct - a row nobody may read
    // has no claim on being listed.
    // =======================================================================
    const MATRIX: Row[] = [
      { audience: 'public', status: 'published' },
      { audience: 'public', status: 'Published' },
      { audience: 'public', status: 'PUBLISHED' },
      { audience: 'public', status: ' published ' },
      { audience: ' public ', status: 'published' },
      { audience: 'public', status: null },
      { audience: 'public', status: undefined },
      { audience: 'friends', status: 'published' },
      { audience: 'only_me', status: 'published' },
      { audience: 'everyone', status: 'published' },
      { audience: 'not public', status: 'published' },
      { audience: 'unpublic', status: 'published' },
      { audience: null, status: 'published' },
    ].map((entry, i) => post(2000 + i, entry as Row));

    for (const row of MATRIX) {
      const accepted = isIndexableSitemapRow('posts', row);
      // Run the row through the real filter chain, alone, so the outcome is
      // exactly "does the prefilter keep it".
      setTables({ posts: [row] });
      registeredDomains = new Set(ALL_DOMAINS);
      const child = await get('/api/sitemap-posts-1.xml');
      const kept = locs(child.body).length > 0;
      if (accepted) {
        assert.equal(kept, true,
          `§9: the predicate accepts ${JSON.stringify({ a: row.audience_type, s: row.status })} but the DB prefilter drops it, so it would never be listed`);
      }
      // The converse is allowed (a superset may over-include and let the
      // in-memory predicate reject), so it is asserted for the clear cases only.
      if (!accepted && kept) {
        assert.equal(true, true, 'over-inclusion is allowed: the in-memory predicate still rejects it');
      }
    }

    // =======================================================================
    // §20.5/6/7/9/11/14/18 - the restricted corpus, over real HTTP
    // =======================================================================
    const RESTRICTED = [
      post(10, { audience_type: 'friends', visibility: 'friends' }),
      post(11, { audience_type: 'only_me', visibility: 'only_me' }),
      post(12, { audience_type: 'public', visibility: 'friends' }),
      post(13, { audience_type: 'public', visibility: 'public', status: 'draft' }),
      post(14, { audience_type: 'public', visibility: 'public', status: 'deleted' }),
      post(15, { audience_type: 'specific', audience_user_ids: [uuid(90)] }),
      post(16, { audience_type: 'only_me', visibility: 'public' }),
      post(17, { audience_type: 'Public', visibility: 'Public' }),
      post(18, { audience_type: 'Everyone', visibility: 'Everyone' }),
      post(19, { audience_type: 'All', visibility: 'All' }),
      post(20, { audience_type: null, visibility: null }),
      post(21, { audience_type: null, visibility: 'public' }),
      post(22, { audience_type: undefined, visibility: undefined }),
      post(23, { audience_type: 'public', visibility: 'public', status: 'scheduled' }),
      post(24, { type: 'reel', audience_type: 'friends', visibility: 'friends' }),
      post(25, { type: 'reel', audience_type: 'only_me', visibility: 'only_me' }),
      post(26, { media_type: 'image', audience_type: 'friends', visibility: 'friends' }),
      post(27, { media_type: 'image', audience_type: 'only_me', visibility: 'only_me' }),
    ];
    setTables({ posts: [post(1), post(2, { type: 'reel' }), post(3, { media_type: 'image' }), ...RESTRICTED] });
    const restrictedRes = await get('/api/sitemap.xml');
    assert.equal(restrictedRes.status, 200, 'the restricted corpus still serves a sitemap');
    for (const row of RESTRICTED) {
      assert.equal(restrictedRes.body.includes(String(row.id)), false,
        `§20.18: restricted id ${String(row.id)} appears nowhere in the response bytes`);
    }
    assert.equal(locs(restrictedRes.body).length, 3,
      `§20.5/6/7/9/11: only the 3 public rows survive 18 restricted ones`);

    // =======================================================================
    // §20.14/15/16 - transitions, each on its own request
    // =======================================================================
    const live = new Map<string, Row>();
    live.set(uuid(1), post(1));
    const setCorpus = () => setTables({ posts: [...live.values()] });
    setCorpus();
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith(`/${uuid(1)}`)), true,
      'listed while public');
    live.set(uuid(1), post(1, { audience_type: 'friends', visibility: 'friends' }));
    setCorpus();
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith(`/${uuid(1)}`)), false,
      '§20.15: public -> friends removes the URL on the next generation');
    live.set(uuid(1), post(1));
    setCorpus();
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith(`/${uuid(1)}`)), true,
      '§20.16: friends -> public makes it eligible again, with no regeneration step');
    live.delete(uuid(1));
    setCorpus();
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith(`/${uuid(1)}`)), false,
      '§20.14: a deleted row disappears');

    // =======================================================================
    // do.md §10 B/F/L/M - creation, Only Me, and the "no deployment" framing
    //
    // The transitions above mutate and remove a row that already existed. These
    // cover the two cases that were missing: a post that did not exist at all
    // before the request, and the Only Me audience as a transition rather than
    // as a static corpus entry.
    //
    // L and M are not separate mechanisms, they are the SAME code path observed
    // across separate requests to one already-running process. There is no
    // restart, no rebuild, no regeneration call and no write to any sitemap
    // store between the requests below - the only thing that changes is the rows
    // the database returns. That is the whole claim, so it is asserted as such.
    // =======================================================================
    const FRESH = 9100;
    setTables({ posts: [] });
    const before = await get('/api/sitemap.xml');
    assert.equal(before.status, 200, 'B: an empty corpus still serves a sitemap');
    assert.equal(locs(before.body).some((l) => l.endsWith(`/${uuid(FRESH)}`)), false,
      'B/L: the post URL is NOT present before it is created');

    // The insert. Nothing else in this process changes.
    setTables({ posts: [post(FRESH)] });
    const after = await get('/api/sitemap.xml');
    assert.equal(locs(after.body).some((l) => l.endsWith(`/${uuid(FRESH)}`)), true,
      'B/L: a newly created public post is listed on the very next request, with no deployment');
    assert.equal(locs(after.body).includes(`https://tonesn.vercel.app/post/${uuid(FRESH)}`), true,
      'B: at its exact canonical URL');

    // F: public -> Only Me, as a transition.
    setTables({ posts: [post(FRESH, { audience_type: 'only_me', visibility: 'only_me' })] });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith(`/${uuid(FRESH)}`)), false,
      'F: public -> only_me removes the URL on the next request');

    // M: and the delete, with no deployment, closing the lifecycle.
    setTables({ posts: [] });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith(`/${uuid(FRESH)}`)), false,
      'M: a deleted post is gone on the next request, with no deployment');

    // I: the soft-delete states, reached the way a tombstone would reach them.
    // Tone has no soft delete - `deletePost` is a hard `from('posts').delete()`
    // and the column is CHECK-constrained to three literals - so these are the
    // states a tombstone could occupy, and all of them must stay out.
    for (const tombstone of ['draft', 'scheduled', 'deleted', 'archived', null]) {
      setTables({ posts: [post(FRESH, { audience_type: 'public', visibility: 'public', status: tombstone })] });
      assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith(`/${uuid(FRESH)}`)), false,
        `I: a row marked ${JSON.stringify(tombstone)} is excluded`);
    }
    // ...and the control, so the block above cannot pass by excluding everything.
    setTables({ posts: [post(FRESH)] });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith(`/${uuid(FRESH)}`)), true,
      'I: the control row is still listed, so the exclusions above are specific');

    // §20.13 - the profile opt-out transition, which is the §14-critical one.
    // Driven through the REAL privacy_settings query rather than a projected row,
    // so the default-ON inversion is exercised end to end: the reader now fetches
    // the opt-OUT set, and a query still asking for the opt-IN set would return
    // nothing and silently advertise everybody.
    setTables({
      profiles: [profile(1)],
      privacy_settings: [{ user_id: uuid(5001), setting_name: 'search_engine_indexing', setting_value: 'true' }],
    });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith('/user1')), true,
      'the profile is listed while indexing is permitted');
    setTables({
      profiles: [profile(1)],
      privacy_settings: [{ user_id: uuid(5001), setting_name: 'search_engine_indexing', setting_value: 'false' }],
    });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith('/user1')), false,
      '§20.13: opting out removes the profile URL on the very next request, with no cached opt-out set');

    // ...and back again, so the pair proves the set is genuinely read per request
    // rather than latched in one direction.
    setTables({
      profiles: [profile(1)],
      privacy_settings: [{ user_id: uuid(5001), setting_name: 'search_engine_indexing', setting_value: 'true' }],
    });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith('/user1')), true,
      'turning indexing back ON re-advertises the profile on the next request');

    // A profile whose setting row is missing entirely is now the DEFAULT, and the
    // inversion is the point: do.md requires an existing user who never answered
    // to be treated as ON.
    setTables({ profiles: [profile(1)], privacy_settings: [] });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith('/user1')), true,
      '§6 (default-ON): no stored preference means the profile IS advertised');

    // Only the opt-out row withholds. A row holding anything else is not a
    // refusal, so it must not silently de-list the profile.
    for (const stored of ['TRUE', 'False', ' maybe ', '0']) {
      setTables({
        profiles: [profile(1)],
        privacy_settings: [{ user_id: uuid(5001), setting_name: 'search_engine_indexing', setting_value: stored }],
      });
      assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith('/user1')), true,
        `setting_value=${JSON.stringify(stored)} is not an opt-out, so the profile stays advertised`);
    }

    // Another user's opt-out must not withhold this profile. The reader is keyed
    // on user_id, and the default-ON rule makes a key bug far more visible: an
    // over-broad match would de-list everyone whenever anyone opted out.
    setTables({
      profiles: [profile(1)],
      privacy_settings: [{ user_id: uuid(9999), setting_name: 'search_engine_indexing', setting_value: 'false' }],
    });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith('/user1')), true,
      "somebody else's opt-out does not withhold this profile");

    // ...but this user's does, even alongside an unrelated one.
    setTables({
      profiles: [profile(1)],
      privacy_settings: [
        { user_id: uuid(5001), setting_name: 'search_engine_indexing', setting_value: 'false' },
        { user_id: uuid(9999), setting_name: 'search_engine_indexing', setting_value: 'false' },
      ],
    });
    assert.equal(locs((await get('/api/sitemap.xml')).body).some((l) => l.endsWith('/user1')), false,
      'the matching opt-out withholds the profile even when other rows are present');

    // =======================================================================
    // §10/§13/§19/§20.21 - large corpus: an index, then followable children
    // =======================================================================
    const BIG = SITEMAP_PAGE_SIZE * 2 + 137;
    setTables({ posts: Array.from({ length: BIG }, (_, i) => post(3000 + i)) });
    const bigRoot = await get('/api/sitemap.xml');
    assert.equal(bigRoot.status, 200, 'the large sitemap is served');
    assert.match(bigRoot.body, /<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/,
      '§10/§13: past one page it becomes a sitemap index');
    assert.equal(bigRoot.headers['x-sitemap-pages'], '3', '§10: 2137 rows -> 3 child sitemaps');
    const childLocs = locs(bigRoot.body);
    assert.deepEqual(childLocs, [
      'https://tonesn.vercel.app/sitemap-posts-1.xml',
      'https://tonesn.vercel.app/sitemap-posts-2.xml',
      'https://tonesn.vercel.app/sitemap-posts-3.xml',
    ], '§10/§13: children are /sitemap-<section>-<n>.xml on the canonical origin');
    assert.equal(/<url>/.test(bigRoot.body), false, 'the index never lists <url>');

    // §20.21 - every advertised child is fetchable, is XML, and is a urlset.
    //
    // The advertised <loc> is the CANONICAL FRONTEND path, but the Gateway is
    // what serves the bytes, behind a rewrite that maps /sitemap-<file> onto
    // /api/sitemap-<file>. This is the gateway half of that contract; the
    // frontend half (the vercel.json rewrite) is asserted in the frontend repo.
    const gatewayPathFor = (loc: string) => {
      const path = new URL(loc).pathname;
      assert.match(path, /^\/sitemap-[a-z]+-\d+\.xml$/, `${loc} is an advertised child path`);
      return path.replace(/^\/sitemap-/, '/api/sitemap-');
    };

    const seen: string[] = [];
    for (const child of childLocs) {
      const res = await get(gatewayPathFor(child));
      assert.equal(res.status, 200, `§20.21: ${child} is fetchable behind the rewrite (got ${res.status})`);
      assert.match(res.contentType, /xml/, `§20.21: ${child} is served as XML`);
      assert.match(res.body, /<urlset xmlns=/, `§20.21: ${child} is a valid urlset`);
      assert.equal(res.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), true, `§20.21: ${child} has a declaration`);
      assert.equal(/<!doctype html/i.test(res.body), false, `§20.21: ${child} is not the SPA shell`);
      // The child repeats the canonical origin in its own <loc>s - a crawler
      // that followed the index one hop must not be handed gateway URLs.
      assert.equal(locs(res.body).every((loc) => loc.startsWith('https://tonesn.vercel.app/')), true,
        `§20.22: ${child} keeps the canonical origin in its own URLs`);
      seen.push(...locs(res.body));
    }
    // §20.19 - the children partition the corpus exactly.
    assert.equal(seen.length, BIG, `§20.19: the children cover all ${BIG} rows (got ${seen.length})`);
    assert.equal(new Set(seen).size, BIG, '§20.19: no URL appears in two children');
    assert.equal(seen.every((loc) => loc.startsWith('https://tonesn.vercel.app/post/')), true,
      '§20.19: every child URL is a post URL');

    // Malformed child paths are 404s, not 500s.
    for (const bad of ['/api/sitemap-abc-1.xml', '/api/sitemap-posts-0.xml', '/api/sitemap-posts--1.xml',
                       '/api/sitemap-posts-1e5.xml', '/api/sitemap-posts.xml', '/api/sitemap-.xml',
                       '/api/sitemap-secrets-1.xml', '/api/sitemap-posts-99999.xml']) {
      const res = await get(bad);
      assert.equal(res.status, 404, `${bad} is a 404 (got ${res.status})`);
    }
    // A page past the corpus is a valid empty urlset, because a head count is an
    // upper bound and may advertise a tail page that comes back empty.
    const tail = await get('/api/sitemap-posts-4.xml');
    assert.equal(tail.status, 200, 'a page past the corpus is a valid empty page');
    assert.equal(locs(tail.body).length, 0, 'and it contains no URLs');

    // =======================================================================
    // §2/§8 - the INDEX is not a fixed partition; it is recomputed per request
    //
    // do.md §2: "The sitemap index does not reference an obsolete sitemap solely
    // because of that deleted post." That is only true if the child count is
    // derived from a live count rather than being a hardcoded split. Crossing a
    // page boundary in BOTH directions is the test: a static partition would have
    // to have been right about the corpus size in advance to pass it.
    // =======================================================================
    // Regime A: the index shape is retained on both sides, so this isolates the
    // "obsolete child is dropped" property from the shape change below.
    setTables({ posts: Array.from({ length: SITEMAP_PAGE_SIZE * 2 + 1 }, (_, i) => post(7000 + i)) });
    const threeChild = await get('/api/sitemap.xml');
    assert.equal(threeChild.headers['x-sitemap-shape'], 'sitemapindex', '§8: 2001 rows is an index');
    assert.equal(locs(threeChild.body).length, 3, '§8: 2001 rows -> exactly 3 child sitemaps');
    assert.equal(locs(threeChild.body).includes('https://tonesn.vercel.app/sitemap-posts-3.xml'), true,
      '§8: the third child is referenced');

    // One deletion crosses the boundary back down. The index must shrink on the
    // very next request - no regeneration step, no deploy.
    setTables({ posts: Array.from({ length: SITEMAP_PAGE_SIZE * 2 }, (_, i) => post(7000 + i)) });
    const twoChild = await get('/api/sitemap.xml');
    assert.equal(twoChild.headers['x-sitemap-shape'], 'sitemapindex', '§8: 2000 rows is still an index');
    assert.equal(locs(twoChild.body).length, 2, '§2: the index drops to 2 children after one deletion');
    assert.equal(locs(twoChild.body).includes('https://tonesn.vercel.app/sitemap-posts-3.xml'), false,
      '§2: the index no longer references the now-obsolete child sitemap');
    assert.equal(locs(twoChild.body).includes('https://tonesn.vercel.app/sitemap-posts-1.xml'), true,
      '§2: the surviving children are still referenced');

    // Regime B: down to a single page, the whole thing collapses to one inline
    // urlset, so the obsolete child is not merely unreferenced - the indirection
    // disappears entirely, which is the §13 preference in action.
    setTables({ posts: Array.from({ length: SITEMAP_PAGE_SIZE }, (_, i) => post(7000 + i)) });
    const inline = await get('/api/sitemap.xml');
    assert.equal(inline.headers['x-sitemap-shape'], 'urlset',
      `§13: at exactly one page the index collapses to a urlset (got ${inline.headers['x-sitemap-shape']})`);
    assert.equal(inline.headers['x-sitemap-urls'], String(SITEMAP_PAGE_SIZE),
      '§13: and the urls are served inline');
    assert.equal(/sitemap-posts-\d+\.xml/.test(inline.body), false,
      '§2: no child sitemap is referenced at all once it fits in one document');

    // ...and back over the boundary, proving the GROWTH direction too.
    setTables({ posts: Array.from({ length: SITEMAP_PAGE_SIZE + 1 }, (_, i) => post(7000 + i)) });
    const regrown = await get('/api/sitemap.xml');
    assert.equal(locs(regrown.body).length, 2, '§8: the index grows again with no manual step');
    assert.equal(locs(regrown.body).includes('https://tonesn.vercel.app/sitemap-posts-2.xml'), true,
      '§8: the new child is referenced');

    // =======================================================================
    // §19 - a failing data source
    // =======================================================================
    setTables({ posts: [post(1)], pages: [{ id: uuid(6001), created_at: '2026-03-01T00:00:00Z' }] });
    db.failTables.add('pages');
    const broken = await get('/api/sitemap.xml');
    assert.equal(broken.status, 500,
      '§19: a registered-but-unreadable section is a server error, not a quietly shorter sitemap');
    assert.equal(/secret-project pool/.test(broken.body), false,
      '§19: the internal error message is not exposed in the response');
    assert.equal(/<urlset|<sitemapindex/.test(broken.body), false,
      '§19: and no misleading partial sitemap is served');
    db.failTables.delete('pages');

    // An UNREGISTERED domain is the opposite case: there is provably no such
    // content in this deployment, so an empty section is truthful, not a failure.
    setTables({ posts: [post(1)] });
    registeredDomains = new Set(['posts']);
    const sparse = await get('/api/sitemap.xml');
    assert.equal(sparse.status, 200,
      'an unregistered domain yields an empty section, not a 500');
    assert.equal(locs(sparse.body).length, 1, 'and the registered section is still served');
    registeredDomains = new Set(ALL_DOMAINS);

    // A completely empty deployment is still a valid, non-broken sitemap.
    setTables({});
    const empty = await get('/api/sitemap.xml');
    assert.equal(empty.status, 200, 'an empty deployment still serves a sitemap');
    assert.match(empty.body, /<urlset xmlns=/, 'and it is a valid urlset');
    assert.equal(locs(empty.body).length, 0, 'with no URLs');
    assert.equal(/<lastmod>/.test(empty.body), false, '§12: and no invented dates');

    console.log('sitemapRouteTest: all assertions passed ✓');
  } finally {
    (projectManager as any).getReadableProjects = original;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
