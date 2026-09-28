// do.md "Fix Privacy Checkup - Search Engine Profile Indexing", Gateway side.
//
// UPDATED Sep 28, 2026 for do.md "Search Engine Discovery Must Default to ON".
// The default has been INVERTED: a profile with no stored preference is now
// indexable, and only an explicit 'false' withholds it. Every assertion below
// that used to prove "absent is not consent" now proves the opposite, and the
// ones that survive unchanged are the ones that must survive: the route stays
// unauthenticated, still selects one column, and still never leaks another
// privacy setting.
//
// Three things are under test, in order of how badly a bug would hurt:
//
//   1. The effective value. NULL/missing -> ON, 'true' -> ON, 'false' -> OFF.
//      The 'false' case is the one that now carries all the weight, because it is
//      the ONLY thing that withholds a profile. A regression that widened the
//      comparison ('!= false' becoming '== false', or a trim/lowercase pass) would
//      look like a robustness fix and would publish people who said no.
//
//   2. The read is three-state. A missing row and an unreadable table are
//      different facts with different answers under a permissive default, and
//      collapsing them - the way a two-state `unknown` forces you to - is how a
//      database blip becomes a mass publication of opted-out profiles.
//
//   3. The route. Unauthenticated, one username, one column, no leakage.
//
// Run: npm run test:profile-indexing
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { router } from '../api/routes';
import { projectManager } from '../project-manager';
import { isIndexableProfileRow } from './sitemap';
import {
  PROFILE_INDEXING_OPT_IN,
  PROFILE_INDEXING_OPT_OUT,
  PROFILE_INDEXING_SETTING,
  isSearchEngineIndexingEnabled,
  isValidProfileUsername,
  readProfileIndexing,
  type IndexingRead,
  type ProfileIndexingDeps,
} from './profileIndexing';

type Row = Record<string, unknown>;
type Filter = [string, unknown];
interface RecordedQuery {
  table: string;
  select: unknown;
  filters: Filter[];
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. The effective value - do.md's required semantics, exactly
  // -------------------------------------------------------------------------
  assert.equal(PROFILE_INDEXING_SETTING, 'search_engine_indexing',
    'the setting key must stay equal to the literal PrivacyCheckup.tsx writes');
  assert.equal(PROFILE_INDEXING_OPT_IN, 'true',
    "'true' is what the switch writes when the user permits indexing");
  assert.equal(PROFILE_INDEXING_OPT_OUT, 'false',
    "'false' is the ONLY value that withholds a profile");

  // NULL / missing -> ON.  This is the change.
  assert.equal(isSearchEngineIndexingEnabled(null), true, 'NULL/missing defaults to ON');
  assert.equal(isSearchEngineIndexingEnabled(undefined), true, 'undefined defaults to ON');
  // TRUE -> ON.
  assert.equal(isSearchEngineIndexingEnabled('true'), true, "'true' is ON");
  // FALSE -> OFF.  The one value that withholds.
  assert.equal(isSearchEngineIndexingEnabled('false'), false, "'false' is the only OFF");

  // Everything else falls to the default. Each is a real possibility - drift in
  // the column, a partial write, a different client, a JSON boolean where a
  // string was expected - and under a default-ON rule none of them may be read
  // as a refusal, because a refusal is something a person has to express and
  // these are not expressions of one.
  for (const fallsToDefault of [
    'TRUE', 'True', ' true', 'true ', 'FALSE', 'False', ' false', 'false ',
    'yes', 'no', '1', '0', 'on', 'off', '', true, false, 1, 0, {}, [], ['false'],
  ]) {
    assert.equal(isSearchEngineIndexingEnabled(fallsToDefault), true,
      `${JSON.stringify(fallsToDefault)} is not an explicit opt-out, so it takes the ON default`);
  }

  // The comparison on the OFF side is exact, and that is load-bearing rather than
  // incidental: a lenient 'false' test would let 'FALSE' or ' false' through as
  // an opt-out, de-listing a user who did not ask for it. The switch writes
  // exactly 'false' (c.toString() on a boolean), so exactness costs nothing and
  // removes a whole class of silent de-listing.
  for (const notAnOptOut of ['FALSE', 'False', ' false', 'false ', 'no', '0', 'off', false, 0]) {
    assert.equal(isSearchEngineIndexingEnabled(notAnOptOut), true,
      `${JSON.stringify(notAnOptOut)} must not be treated as an opt-out`);
  }

  // -------------------------------------------------------------------------
  // 2. Username validation - the app's own convention
  // -------------------------------------------------------------------------
  for (const good of ['ada', 'ada_2', 'A', 'a'.repeat(64), '_x']) {
    assert.equal(isValidProfileUsername(good), true, `${good} is a valid username`);
  }
  for (const bad of [
    '', 'a'.repeat(65), 'ada.lovelace', 'ada lovelace', 'ada/../etc', 'ada%20',
    "ada'", 'ada"', 'ada\tada', 'ada ', null, undefined, 42, {},
  ]) {
    assert.equal(isValidProfileUsername(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }

  // -------------------------------------------------------------------------
  // 3. The reader, with injected deps
  // -------------------------------------------------------------------------
  // The three-state read, so each state can be driven on its own. A helper that
  // returned the bare column value would make 'no row' and 'unreadable'
  // indistinguishable, which is precisely the collapse this change has to avoid.
  const depsFor = (read: IndexingRead): ProfileIndexingDeps => ({
    async findProfileIdsByUsername() {
      return ['user-1'];
    },
    async readIndexingSetting() {
      return read;
    },
  });
  const withValue = (setting_value: unknown): ProfileIndexingDeps =>
    depsFor({ kind: 'value', value: setting_value });

  assert.deepEqual(
    await readProfileIndexing('ada', withValue('true')),
    { found: true, enabled: true },
    'an explicit ON indexes the profile'
  );

  // The new default: a real profile that never answered the question.
  assert.deepEqual(
    await readProfileIndexing('ada', depsFor({ kind: 'absent' })),
    { found: true, enabled: true },
    'a profile with NO setting row is indexable - do.md: existing user with no stored preference is ON'
  );
  assert.deepEqual(
    await readProfileIndexing('ada', withValue('false')),
    { found: true, enabled: false },
    'an explicit opt-out is the one thing that withholds, and it must always win'
  );
  assert.deepEqual(
    await readProfileIndexing('ada', withValue('TRUE')),
    { found: true, enabled: true },
    'a wrong-case value is drift, not an opt-out, so it takes the default'
  );

  // A username nobody has. The settings read must not even be attempted.
  const noProfile: ProfileIndexingDeps = {
    async findProfileIdsByUsername() {
      return [];
    },
    async readIndexingSetting() {
      throw new Error('must not be asked about a profile that does not exist');
    },
  };
  assert.deepEqual(
    await readProfileIndexing('ghost', noProfile),
    { found: false, enabled: false },
    'an unknown username is not found, and is still not indexable'
  );

  // Infrastructure failure. The profile is real, so `found` stays true, but the
  // answer is unreadable - and this is the case the default-ON rule puts at
  // risk. "I could not determine this" is NOT "there is no preference": a
  // timeout while somebody holds an explicit 'false' would otherwise resolve to
  // the ON default and publish them.
  const unreadable: ProfileIndexingDeps = {
    async findProfileIdsByUsername() {
      return ['user-1'];
    },
    async readIndexingSetting() {
      return { kind: 'unreadable' };
    },
  };
  assert.deepEqual(
    await readProfileIndexing('ada', unreadable),
    { found: true, enabled: false },
    'an UNREADABLE preference fails closed - it is not the same fact as an absent one'
  );

  // And the same for a thrown read, which is the shape a real timeout takes.
  const exploding: ProfileIndexingDeps = {
    async findProfileIdsByUsername() {
      return ['user-1'];
    },
    async readIndexingSetting() {
      throw new Error('supabase timeout');
    },
  };
  assert.deepEqual(
    await readProfileIndexing('ada', exploding),
    { found: true, enabled: false },
    'a thrown settings read fails CLOSED, not open'
  );

  // A failure resolving the PROFILE is a different problem: `found` is genuinely
  // unknown, so 404 is the honest answer. Answering 200/false would let an
  // outage be used as a username oracle; answering 200/true would publish.
  const explodingProfile: ProfileIndexingDeps = {
    async findProfileIdsByUsername() {
      throw new Error('profiles timeout');
    },
    async readIndexingSetting() {
      throw new Error('must not be reached');
    },
  };
  assert.deepEqual(
    await readProfileIndexing('ada', explodingProfile),
    { found: false, enabled: false },
    'a failed profile read reports not-found rather than leaking the existence of a real user'
  );

  assert.deepEqual(
    await readProfileIndexing('not a username', withValue('true')),
    { found: false, enabled: false },
    'a malformed username never reaches the database'
  );

  // -------------------------------------------------------------------------
  // 4. The sitemap agrees with the profile page, on every value
  // -------------------------------------------------------------------------
  // do.md requires the profile page AND the dynamic sitemap to honour this one
  // setting. They are two code paths reading one column, so the risk is not that
  // one is wrong but that they are wrong in DIFFERENT directions - the page
  // saying "index me" for a row the sitemap has stopped listing, or the sitemap
  // listing a row the page has marked noindex. Google is then told to crawl a URL
  // the sitemap just withdrew.
  //
  // This drives the sitemap's own predicate with the same values the route test
  // uses, so any future divergence in the shared test fails here.
  {
    const sitemapSaysIndexable = (value: unknown) =>
      isIndexableProfileRow({
        id: 'user-1',
        username: 'ada',
        search_engine_indexing: value,
      } as never);
    // The route's view of the same value, straight from the shared predicate.
    const pageSaysIndexable = (value: unknown) => isSearchEngineIndexingEnabled(value);

    for (const value of ['true', 'false', 'TRUE', 'True', ' true', 'true ', 'FALSE', 'false ',
                         'yes', '1', '0', '', null, undefined, true, false, 1, 0]) {
      assert.equal(
        sitemapSaysIndexable(value),
        pageSaysIndexable(value),
        `the sitemap and the profile page must agree on ${JSON.stringify(value)}`
      );
    }
    assert.equal(sitemapSaysIndexable('true'), true, 'and an explicit ON indexes both');
    assert.equal(sitemapSaysIndexable('false'), false, 'and an opt-out withdraws from both');
    assert.equal(sitemapSaysIndexable(undefined), true,
      'and an absent row indexes both - the default is now ON on both surfaces');

    // A username the app could never link to is not listed, whatever the answer.
    for (const username of ['ada.lovelace', 'ada lovelace', '', 'a'.repeat(65)]) {
      assert.equal(
        isIndexableProfileRow({ id: 'user-1', username, search_engine_indexing: 'true' } as never),
        false,
        `${JSON.stringify(username)} is not a listable profile path`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 5. The route, over a real listener
  // -------------------------------------------------------------------------
  const queries: RecordedQuery[] = [];
  let tables: Record<string, Row[]> = {};
  let failing = new Set<string>();

  // Each chain method is explicit rather than built by one shared closure. A
  // closure over the method name captures 'from' once and never records the
  // method a later call actually used, which turns every filter into a no-op and
  // makes the whole route section pass for the wrong reason.
  const record = (table: string) => {
    const entry: RecordedQuery = { table, select: undefined, filters: [] };
    const self: any = {
      select: (s: unknown) => {
        entry.select = s;
        return self;
      },
      eq: (column: string, v: unknown) => {
        entry.filters.push([`eq:${column}`, v]);
        return self;
      },
      in: (column: string, v: unknown) => {
        entry.filters.push([`in:${column}`, v]);
        return self;
      },
      limit: () => self,
    };
    // Thenable, so `await` resolves the chain the way supabase-js does.
    self.then = (resolve: (v: unknown) => void) => {
      if (failing.has(table)) return resolve({ data: null, error: { message: 'boom' } });
      let rows = tables[table] ?? [];
      for (const [f, v] of entry.filters) {
        const [method, column] = f.split(':');
        if (method === 'eq') rows = rows.filter((r) => String(r[column]) === String(v));
        if (method === 'in') rows = rows.filter((r) => (v as unknown[]).map(String).includes(String(r[column])));
      }
      resolve({ data: rows, error: null });
    };
    queries.push(entry);
    return self;
  };

  const original = projectManager.getReadableProjects.bind(projectManager);
  (projectManager as any).getReadableProjects = (domain: string) =>
    ['profiles', 'users', 'privacy_settings'].includes(domain)
      ? [{ client: { from: (t: string) => record(t) } }]
      : [];

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    const body = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* not json */
    }
    return { status: res.status, headers: res.headers, json, body };
  };

  try {
    // --- a brand-new user: no row at all, and the default is ON -------
    // This is the do.md headline case. A user who has never opened the privacy
    // checkup has no row, and the route must say ON - while still being a 200,
    // because the profile demonstrably exists.
    tables = { profiles: [{ id: 'user-1', username: 'ada' }], privacy_settings: [] };
    queries.length = 0;
    const fresh = await get('/api/public/profile-indexing?username=ada');
    assert.equal(fresh.status, 200, `a brand-new user answers 200 (got ${fresh.status}: ${fresh.body})`);
    assert.deepEqual(fresh.json, { search_engine_indexing: true },
      'do.md: a brand-new user with no stored preference is ON, not OFF');

    // --- an explicit ON, unauthenticated -----------------------------
    tables = {
      profiles: [{ id: 'user-1', username: 'ada' }],
      privacy_settings: [
        { user_id: 'user-1', setting_name: 'search_engine_indexing', setting_value: 'true' },
      ],
    };
    queries.length = 0;
    const on = await get('/api/public/profile-indexing?username=ada');
    assert.equal(on.status, 200, `ON answers 200 logged out (got ${on.status}: ${on.body})`);
    assert.deepEqual(on.json, { search_engine_indexing: true }, 'ON reports the effective value');

    // No auth challenge: a crawler has no session, and gating this on one would
    // mean the directive can only be produced for a signed-in viewer.
    assert.equal(on.headers.get('www-authenticate'), null, 'and it is not an auth challenge');

    // --- it selects the minimum, and never another privacy setting ----
    // Unchanged by this round, and asserted again because the permissive default
    // makes a leak here worse: a wider SELECT is no longer merely untidy, it is a
    // wider read on a record whose values now mostly resolve to "publish me".
    const settingsQuery = queries.find((q) => q.table === 'privacy_settings');
    assert.ok(settingsQuery, 'the setting was read');
    const selectedCols = String(settingsQuery.select).split(',').map((c) => c.trim());
    assert.deepEqual(selectedCols, ['setting_value'],
      `only the one column is selected, never the rest of the privacy config (got ${selectedCols})`);
    assert.deepEqual(
      settingsQuery.filters.find(([f]) => f === 'eq:setting_name'),
      ['eq:setting_name', 'search_engine_indexing'],
      'and it is constrained to this setting, so no other preference is readable through here'
    );
    const profileQuery = queries.find((q) => q.table === 'profiles');
    assert.ok(profileQuery, 'the profile was resolved from the username');
    assert.deepEqual(String(profileQuery.select).split(',').map((c) => c.trim()), ['id'],
      'the profile read asks for the id only');

    // The filter that finds the profile must actually be applied - if the stub's
    // chain were inert, every assertion above would pass without the route
    // filtering anything at all.
    assert.deepEqual(
      profileQuery.filters.find(([f]) => f === 'eq:username'),
      ['eq:username', 'ada'],
      'the profile is looked up by the requested username, not returned wholesale'
    );

    // --- only an explicit 'false' withholds ---------------------------
    // Every one of these is a 200 with enabled:true, including the ones that
    // used to be the "not indexable" list. They are grouped with a comment
    // because the point is that the set shrank to exactly one value.
    for (const [label, value] of [
      ['wrong case TRUE', 'TRUE'],
      ['wrong case FALSE', 'FALSE'],
      ['padded false', ' false '],
      ['garbage', 'maybe'],
      ['numeric', '0'],
      ['boolean-ish', 'no'],
    ] as const) {
      tables = {
        profiles: [{ id: 'user-1', username: 'ada' }],
        privacy_settings: [{ user_id: 'user-1', setting_name: 'search_engine_indexing', setting_value: value }],
      };
      const res = await get('/api/public/profile-indexing?username=ada');
      assert.equal(res.status, 200, `${label}: the profile exists, so 200 (got ${res.status})`);
      assert.deepEqual(res.json, { search_engine_indexing: true },
        `${label}: not an explicit opt-out, so it takes the ON default`);
    }

    // The one that matters, asserted on its own and unmistakably.
    tables = {
      profiles: [{ id: 'user-1', username: 'ada' }],
      privacy_settings: [{ user_id: 'user-1', setting_name: 'search_engine_indexing', setting_value: 'false' }],
    };
    const off = await get('/api/public/profile-indexing?username=ada');
    assert.equal(off.status, 200, 'an explicit opt-out is still a 200: the profile exists');
    assert.deepEqual(off.json, { search_engine_indexing: false },
      "do.md: the user's explicit OFF must always take precedence over the default");

    // --- the ON -> OFF -> OFF transition --------------------------------
    // "old user changes ON -> OFF -> OFF" from do.md's test list. Kept separate
    // from the OFF -> ON case below rather than folded into it, because the two
    // start from different states and only one of them is dangerous.
    //
    // This is the transition that must not regress under a permissive default.
    // A row that already says 'true' is the case where "the user said no" has to
    // be distinguishable from "the user never said anything", and the whole rule
    // is that the former always wins. The third step re-asserts the OFF, because
    // a flip that stuck once can still be undone by a later defaulting pass - and
    // the 'true' -> 'true' tail of the other transition proves the reverse
    // (a re-asserted ON does not decay), so together the pair shows the value
    // is read fresh in both directions rather than latched either way.
    for (const [label, stored, expected] of [
      ['from an explicit ON', 'true', true],
      ['after turning OFF', 'false', false],
      ['and it stays OFF', 'false', false],
    ] as const) {
      tables = {
        profiles: [{ id: 'user-1', username: 'ada' }],
        privacy_settings: [{ user_id: 'user-1', setting_name: 'search_engine_indexing', setting_value: stored }],
      };
      const res = await get('/api/public/profile-indexing?username=ada');
      assert.deepEqual(res.json, { search_engine_indexing: expected }, `do.md transition: ${label}`);
    }

    // --- the OFF -> ON round trip -------------------------------------
    // "user changes OFF -> ON -> ON again" from do.md's test list, driven
    // through the route so it exercises the real read rather than the predicate.
    // The stored row is what changes, never the code.
    for (const [label, stored, expected] of [
      ['after turning OFF', 'false', false],
      ['after turning back ON', 'true', true],
      ['and it stays ON', 'true', true],
    ] as const) {
      tables = {
        profiles: [{ id: 'user-1', username: 'ada' }],
        privacy_settings: [{ user_id: 'user-1', setting_name: 'search_engine_indexing', setting_value: stored }],
      };
      const res = await get('/api/public/profile-indexing?username=ada');
      assert.deepEqual(res.json, { search_engine_indexing: expected }, `do.md round trip: ${label}`);
    }

    // --- unknown username is 404, not a fake "opted out" --------------
    tables = { profiles: [] };
    const ghost = await get('/api/public/profile-indexing?username=ghost');
    assert.equal(ghost.status, 404, `an unknown username is 404 (got ${ghost.status})`);

    // --- malformed usernames are 400 and never reach the database -----
    for (const bad of ['ada.lovelace', 'ada lovelace', "ada'", 'a'.repeat(65), 'ada%20']) {
      queries.length = 0;
      const res = await get(`/api/public/profile-indexing?username=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `${JSON.stringify(bad)} is a 400 (got ${res.status})`);
      assert.equal(queries.length, 0, `${JSON.stringify(bad)} issued no database query`);
    }
    const missing = await get('/api/public/profile-indexing');
    assert.equal(missing.status, 400, `a missing username is a 400 (got ${missing.status})`);
    const repeated = await get('/api/public/profile-indexing?username=ada&username=bob');
    assert.equal(repeated.status, 400, 'a repeated username param is a 400, not an array being coerced');

    // --- an unreadable table does NOT become the default -------------
    // The sharpest edge of this whole change. The profile exists, the table
    // errors, and the two candidate answers are "no stored preference" (ON) and
    // "I could not read the preference" (OFF). The second is correct: the user
    // may well hold an explicit 'false', and resolving their timeout to ON
    // publishes them. Asserted here over the real route because this is exactly
    // where a two-state read would pass silently.
    tables = {
      profiles: [{ id: 'user-1', username: 'ada' }],
      privacy_settings: [{ user_id: 'user-1', setting_name: 'search_engine_indexing', setting_value: 'false' }],
    };
    failing = new Set(['privacy_settings']);
    const broken = await get('/api/public/profile-indexing?username=ada');
    assert.equal(broken.status, 200, 'a failed settings read still answers, so the client can render');
    assert.deepEqual(broken.json, { search_engine_indexing: false },
      'an unreadable preference must NOT fall through to the ON default');
    assert.equal(/boom|supabase|error/i.test(broken.body), false,
      'and no internal error text is exposed in the response');

    // A failed PROFILE read is a different failure: 404, because `found` is
    // genuinely unknown and 200 would answer the existence question with a lie.
    failing = new Set(['profiles']);
    const brokenProfile = await get('/api/public/profile-indexing?username=ada');
    assert.equal(brokenProfile.status, 404,
      'a failed profile read is 404 - it must not claim a real user does not exist');
    failing = new Set();

    // --- it is not cached ---------------------------------------------
    // Every other public read in the Gateway is shared for 5 minutes. Under the
    // old rule a stale `true` could only withhold a URL; now it can PUBLISH one,
    // so this is the assertion that matters most on this route.
    assert.equal(on.headers.get('cache-control'), 'no-store',
      `the directive source must not be cached (got ${on.headers.get('cache-control')})`);
    assert.equal((on.headers.get('cache-control') || '').includes('s-maxage'), false,
      'and specifically carries no shared-cache TTL');
    assert.equal(fresh.headers.get('cache-control'), 'no-store',
      'the default-ON answer is cached no more than the explicit one would be');

    // --- it is not the domain catch-all -------------------------------
    // A two-segment path, so `/:domain` cannot swallow it. Asserted so a future
    // route move cannot quietly turn it into a domain read.
    assert.notEqual(on.body, 'Not found', 'the route is reachable, not routed as a domain');
  } finally {
    (projectManager as any).getReadableProjects = original;
    server.close();
  }

  console.log('profileIndexingTest: all assertions passed ✓');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
