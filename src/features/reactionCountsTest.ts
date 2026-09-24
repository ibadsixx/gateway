// Runnable offline test-suite for the Gateway reaction-count endpoint
// (do.md "Guest users — reaction visibility" round).
//
// Guests viewing a PUBLIC post must see the total reaction count (and the
// summary icons the app already renders) even though they cannot read the
// reactions list (which carries reactor identities) and cannot react. The
// count is computed server-side, independent of any filtered list, and only
// aggregate numbers are returned. These tests prove the counting queries:
// per-type grouping, totals, fan-out + merge across hosts, hosts without the
// table skipped, and that ONLY the `type` column is ever selected (never
// `user_id`).
//
// Run: npm run test:reaction-counts
import assert from 'node:assert/strict';
import {
  getReactionCounts,
  groupReactionTypes,
  mergeReactionTypes,
  type CountClient,
  type ReactionTypeMap,
} from './reactionCounts';

interface CountCall {
  table: string;
  selectColumns: string;
  filters: string[];
}

/** Fake client for `from('reactions').select('type').eq('post_id', id)`. */
function clientFor(
  rows: Array<{ type?: string }>,
  opts: { throwOnTable?: boolean; errorOnTable?: boolean } = {}
): { client: CountClient; calls: CountCall[] } {
  const calls: CountCall[] = [];
  const client: CountClient = {
    from(table: string) {
      if (opts.throwOnTable) throw new Error(`relation "${table}" does not exist`);
      const call: CountCall = { table, selectColumns: '', filters: [] };
      calls.push(call);
      const chain: any = {
        select: (cols: string) => {
          call.selectColumns = cols;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          call.filters.push(`${col}=eq.${String(val)}`);
          if (opts.errorOnTable) {
            return Promise.resolve({ data: null, error: { message: `relation "${table}" does not exist` } });
          }
          return Promise.resolve({ data: rows, error: null });
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

function sorted(map: ReactionTypeMap): ReactionTypeMap {
  const out: ReactionTypeMap = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

async function main() {
  const POST = '11111111-1111-4111-8111-111111111111';

  // --- 1. Pure grouping ------------------------------------------------
  check(
    'groupReactionTypes aggregates by type',
    sorted(groupReactionTypes([
      { type: 'ok' },
      { type: 'red_heart' },
      { type: 'ok' },
      { type: 'laughing' },
      { type: 'ok' },
    ])),
    { laughing: 1, ok: 3, red_heart: 1 }
  );
  check('groupReactionTypes skips rows without type', groupReactionTypes([{ type: 'ok' }, {}]), { ok: 1 });
  check('groupReactionTypes handles empty input', groupReactionTypes([]), {});

  // --- 2. Pure merge ----------------------------------------------------
  check(
    'mergeReactionTypes sums across hosts',
    sorted(mergeReactionTypes([{ ok: 2, cry: 1 }, { ok: 3, rage: 4 }, { cry: 2 }])),
    { cry: 3, ok: 5, rage: 4 }
  );
  check('mergeReactionTypes handles empty maps', mergeReactionTypes([{}, {}]), {});

  // --- 3. Single-host counts -------------------------------------------
  {
    const { client } = clientFor([
      { type: 'ok' },
      { type: 'red_heart' },
      { type: 'ok' },
      { type: 'laughing' },
    ]);
    const counts = await getReactionCounts([{ client }], POST);
    check(
      'single-host counts + types',
      sorted(counts.reaction_types),
      { laughing: 1, ok: 2, red_heart: 1 }
    );
    check('single-host total', counts.reaction_count, 4);
  }

  // --- 4. Cross-host split is summed ----------------------------------
  {
    const { client: a } = clientFor([{ type: 'ok' }, { type: 'ok' }]);
    const { client: b } = clientFor([{ type: 'ok' }, { type: 'rage' }, { type: 'rage' }]);
    const counts = await getReactionCounts([{ client: a }, { client: b }], POST);
    check('cross-host types merged', sorted(counts.reaction_types), { ok: 3, rage: 2 });
    check('cross-host total', counts.reaction_count, 5);
  }

  // --- 5. Host without the table (throws) is skipped -------------------
  {
    const { client: good } = clientFor([{ type: 'ok' }, { type: 'ok' }]);
    const { client: broken } = clientFor([], { throwOnTable: true });
    const counts = await getReactionCounts([{ client: good }, { client: broken }], POST);
    check('throwing host skipped', counts.reaction_count, 2);
  }

  // --- 6. Host reporting an error (PostgREST 404) is skipped -----------
  {
    const { client: good } = clientFor([{ type: 'red_heart' }]);
    const { client: err } = clientFor([], { errorOnTable: true });
    const counts = await getReactionCounts([{ client: good }, { client: err }], POST);
    check('erroring host skipped', counts.reaction_count, 1);
  }

  // --- 7. No readable projects -> zero count ---------------------------
  {
    const counts = await getReactionCounts([], POST);
    check('no projects -> zero count', counts, { reaction_count: 0, reaction_types: {} });
  }

  // --- 8. Query shape: only `type` is selected, pinned to the post -----
  {
    const { client, calls } = clientFor([{ type: 'ok' }]);
    await getReactionCounts([{ client }], POST);
    const call = calls[0];
    check('queries the reactions table', call.table, 'reactions');
    // Only the type column — never user_id (reactor identities).
    check('selects only type (no user_id)', call.selectColumns, 'type');
    check('pins the post id', call.filters, [`post_id=eq.${POST}`]);
  }

  console.log(`\nreaction-counts: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});