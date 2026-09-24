// Runnable offline test-suite for the Gateway relationship-count endpoint
// (do.md "Friends count must remain visible even when the Friends list is
// hidden" round).
//
// The count is public profile metadata: the gateway returns the real server-side
// friends/following/followers COUNT to every viewer (owner, friend, non-friend,
// guest) even when the underlying list is not accessible, WITHOUT ever shipping
// the individual friendship/follower rows. These tests prove the counting
// queries: correct filters, exact head-counts summed across every readable
// host, hosts without the table skipped, and zero row data in any response.
//
// Run: npm run test:relationship-counts
import assert from 'node:assert/strict';
import {
  getRelationshipCounts,
  sumHeadCounts,
  type CountClient,
  type CountProjects,
  type RelationshipCounts,
} from './relationshipCounts';

type Row = Record<string, string>;

interface HeadCountCall {
  table: string;
  selectColumns: string;
  selectOptions: Record<string, unknown>;
  filters: string[];
}

/** Matches one `col=eq.val` filter or an `or(a.eq.v1,b.eq.v2)` expression. */
function matchFilter(filter: string, row: Row): boolean {
  const orM = filter.match(/^or\((.+)\)$/);
  if (orM) {
    // The friends query uses `or(requester_id.eq.X,receiver_id.eq.X)` (OR of
    // two equality terms) — mirror PostgREST semantics exactly.
    return orM[1]
      .split(',')
      .map((t) => t.trim())
      .some((t) => {
        const m = t.match(/^(\w+)\.eq\.(.+)$/);
        return !!m && row[m[1]] === m[2];
      });
  }
  const m = filter.match(/^(\w+)=eq\.(.+)$/);
  return !!m && row[m[1]] === m[2];
}

/**
 * Fake supabase client implementing `from(table).select(cols, opts).or|eq(...)`
 * with an exact head-count. Records every call so the harness can assert the
 * query shape the gateway actually builds (head: true, count: 'exact', correct
 * filters) and prove `data` is always empty.
 */
function headCountClient(
  tables: Record<string, Row[]>,
  opts: { throwOnTables?: Set<string>; errorOnTables?: Set<string> } = {}
): { client: CountClient; calls: HeadCountCall[] } {
  const calls: HeadCountCall[] = [];
  const client: CountClient = {
    from(table: string) {
      if (opts.throwOnTables?.has(table)) {
        throw new Error(`relation "${table}" does not exist`);
      }
      const rows = tables[table] || [];
      const filters: string[] = [];
      const call: HeadCountCall = { table, selectColumns: '', selectOptions: {}, filters };
      calls.push(call);
      const chain: any = {
        select: (columns: string, options?: Record<string, unknown>) => {
          call.selectColumns = columns;
          call.selectOptions = options || {};
          return chain;
        },
        or: (expr: string) => {
          filters.push(`or(${expr})`);
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters.push(`${col}=eq.${String(val)}`);
          if (opts.errorOnTables?.has(table)) {
            return Promise.resolve({ count: null, error: { message: `relation "${table}" does not exist` }, data: null });
          }
          const matched = rows.filter((r) => filters.every((f) => matchFilter(f, r)));
          return Promise.resolve({ count: matched.length, error: null, data: [] });
        },
      };
      return chain;
    },
  };
  return { client: client as unknown as CountClient, calls };
}

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}:`, err);
  }
}

async function main() {
  // --- Fixtures ---------------------------------------------------------
  const P1 = '11111111-1111-4111-8111-111111111111';
  const F2 = '22222222-2222-4222-8222-222222222222';
  const F3 = '33333333-3333-4333-8333-333333333333';
  const F4 = '44444444-4444-4444-8444-444444444444';
  const F5 = '55555555-5555-4555-8555-555555555555';
  const F6 = '66666666-6666-4666-8666-666666666666';
  const F7 = '77777777-7777-4777-8777-777777777777';
  const F8 = '88888888-8888-4888-8888-888888888888';
  const F9 = '99999999-9999-4999-8999-999999999999';
  const F10 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const friendsRows: Row[] = [
    { requester_id: P1, receiver_id: F2, status: 'accepted' }, // friend (P1 is requester)
    { requester_id: F3, receiver_id: P1, status: 'accepted' }, // friend (P1 is receiver)
    { requester_id: P1, receiver_id: F4, status: 'pending' }, // NOT accepted -> not a friend
    { requester_id: F5, receiver_id: F6, status: 'accepted' }, // unrelated pair
  ];
  const followersRows: Row[] = [
    { follower_id: P1, following_id: F7 }, // P1 follows F7 -> following count
    { follower_id: F8, following_id: P1 }, // F8 follows P1 -> followers count
    { follower_id: P1, following_id: F9 }, // P1 follows F9 -> following count
    { follower_id: F10, following_id: F9 }, // unrelated
  ];

  // --- 1. Single-host counts: correct filters and totals -----------------
  {
    const { client: friendsClient } = headCountClient({ friends: friendsRows });
    const { client: followersClient } = headCountClient({ followers: followersRows });
    const counts = await getRelationshipCounts(
      { friends: [{ client: friendsClient }], followers: [{ client: followersClient }] },
      P1
    );
    check('single-host counts', counts, {
      friends_count: 2,
      following_count: 2,
      followers_count: 1,
    } satisfies RelationshipCounts);
  }

  // --- 2. Table split across multiple hosts is summed --------------------
  {
    const sliceA = friendsRows.slice(0, 2); // both P1 rows
    const sliceB = [friendsRows[2], friendsRows[3], { requester_id: P1, receiver_id: F2, status: 'accepted' } as Row];
    const { client: a } = headCountClient({ friends: sliceA });
    const { client: b } = headCountClient({ friends: sliceB });
    const { client: f } = headCountClient({ followers: followersRows });
    const counts = await getRelationshipCounts(
      {
        friends: [{ client: a }, { client: b }],
        followers: [{ client: f }],
      },
      P1
    );
    // sliceA: 2 (both P1 rows); sliceB: 1 (the extra duplicate row) — the
    // pending + unrelated rows are excluded on both hosts.
    check('cross-host split summed', counts.friends_count, 3);
  }

  // --- 3. Host without the table (throws) is skipped ---------------------
  {
    const { client: friendsClient } = headCountClient({ friends: friendsRows });
    const { client: followersClient } = headCountClient({ followers: followersRows });
    const { client: broken } = headCountClient({}, { throwOnTables: new Set(['friends']) });
    const counts = await getRelationshipCounts(
      {
        friends: [{ client: friendsClient }, { client: broken }],
        followers: [{ client: followersClient }],
      },
      P1
    );
    check('throwing host skipped', counts, {
      friends_count: 2,
      following_count: 2,
      followers_count: 1,
    } satisfies RelationshipCounts);
  }

  // --- 4. Host reporting an error (PostgREST 404) is skipped -------------
  {
    const { client: friendsClient } = headCountClient({ friends: friendsRows });
    const { client: followersClient } = headCountClient({ followers: followersRows });
    const { client: err } = headCountClient({}, { errorOnTables: new Set(['followers']) });
    const counts = await getRelationshipCounts(
      {
        friends: [{ client: friendsClient }],
        followers: [{ client: followersClient }, { client: err }],
      },
      P1
    );
    check('erroring host skipped', counts, {
      friends_count: 2,
      following_count: 2,
      followers_count: 1,
    } satisfies RelationshipCounts);
  }

  // --- 5. No readable projects -> zeros (matches an empty list read) -----
  {
    const counts = await getRelationshipCounts({ friends: [], followers: [] }, P1);
    check('no projects -> zeros', counts, { friends_count: 0, following_count: 0, followers_count: 0 });
  }

  // --- 6. Query shape: head-count only, no row data ever returned --------
  {
    const { client: friendsClient, calls: friendsCalls } = headCountClient({ friends: friendsRows });
    const { client: followersClient, calls: followersCalls } = headCountClient({ followers: followersRows });
    await getRelationshipCounts(
      { friends: [{ client: friendsClient }], followers: [{ client: followersClient }] },
      P1
    );
    const friendCall = friendsCalls[0];
    check('friends query uses head+exact count', friendCall.selectOptions, {
      count: 'exact',
      head: true,
    });
    check('friends query selects only the pk', friendCall.selectColumns, 'id');
    check(
      'friends query pins both directions + accepted status',
      friendCall.filters,
      [`or(requester_id.eq.${P1},receiver_id.eq.${P1})`, 'status=eq.accepted']
    );
    const followingCall = followersCalls[0];
    check('following query pins follower_id', followingCall.filters, [`follower_id=eq.${P1}`]);
    const followersCall = followersCalls[1];
    check('followers query pins following_id', followersCall.filters, [`following_id=eq.${P1}`]);

    // sumHeadCounts receives only counts — assert the zombies (counts) arrive
    // with no data: the fake always resolves data: [] and the consumer never
    // touches it. Re-simulate one call directly to prove the shape.
    const { client: isolated } = headCountClient({ friends: friendsRows.slice(0, 1) });
    const raw = await (isolated as any)
      .from('friends')
      .select('id', { count: 'exact', head: true })
      .or(`requester_id.eq.${P1},receiver_id.eq.${P1}`)
      .eq('status', 'accepted');
    check('head-count response ships no rows', raw, { count: 1, error: null, data: [] });
  }

  // --- 7. count includes only ACCEPTED friendship rows -------------------
  {
    const { client: friendsClient } = headCountClient({ friends: friendsRows });
    const n = await sumHeadCounts([{ client: friendsClient }], async (client) =>
      (client as any)
        .from('friends')
        .select('id', { count: 'exact', head: true })
        .or(`requester_id.eq.${P1},receiver_id.eq.${P1}`)
        .eq('status', 'accepted')
    );
    check('pending rows excluded from friends count', n, 2);
  }

  // --- Summary -----------------------------------------------------------
  console.log(`\nrelationship-counts: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});