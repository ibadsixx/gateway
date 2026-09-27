// Offline regression test for the single-row read's error mapping (do.md:
// "the Gateway and the client must agree on one consistent response shape").
//
// GET /api/:domain/:id resolved every read error into a 500 except PostgREST's
// PGRST116 ("zero rows"), which became a 404. A malformed id produced a
// *different* PostgREST error — 22P02, 'invalid input syntax for type uuid' —
// so `GET /api/profiles/not-a-uuid` answered 500 Internal server error for every
// domain, where a well-formed-but-absent id answered 404. The client cannot tell
// a 500 from a transport failure, so a bad id in the path surfaced as an
// unexpected error state instead of the "not found" every other absent row
// produces.
//
// A malformed id can never match a row, so it is a missing row. Both codes map
// to null, and the existing callers already turn null into 404.
//
// Run: npm run test:routing-read
import assert from 'node:assert/strict';
import { projectManager } from '../project-manager';
import { database } from '../infrastructure/database';

type SingleOutcome = { data: unknown; error: { code?: string; message?: string } | null };

/**
 * Serve `.from(domain).select('*').eq('id', id).single()` with a fixed outcome.
 * Only the single-row read shape is implemented, which is all `read` uses.
 */
function fakeClientReturning(outcome: SingleOutcome) {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => outcome,
        }),
      }),
    }),
  } as any;
}

const realGetReadClient = projectManager.getReadClient.bind(projectManager);

function withSingleOutcome<T>(outcome: SingleOutcome, fn: () => Promise<T>): Promise<T> {
  projectManager.getReadClient = ((_domain: string, _id: string) => ({
    client: fakeClientReturning(outcome),
    project: {} as any,
  })) as any;
  return fn().finally(() => {
    projectManager.getReadClient = realGetReadClient;
  });
}

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}:`, error);
  }
}

async function main() {
  await check('a well-formed id with no row (PGRST116) resolves to null', async () => {
    const result = await withSingleOutcome(
      { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
      () => database.read('profiles', '00000000-0000-0000-0000-000000000000')
    );
    assert.equal(result, null);
  });

  await check('a malformed id (22P02 invalid uuid) resolves to null, not a 500', async () => {
    const result = await withSingleOutcome(
      { data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } },
      () => database.read('profiles', 'not-a-uuid')
    );
    assert.equal(result, null, 'a malformed id is a missing row, so callers answer 404');
  });

  await check('a real read failure still rejects, so it is not swallowed into a 404', async () => {
    await assert.rejects(
      withSingleOutcome(
        { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
        () => database.read('profiles', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      ),
      /Read error/
    );
  });

  await check('a found row is returned unchanged', async () => {
    const row = { id: 'u1', username: 'ada' };
    const result = await withSingleOutcome(
      { data: row, error: null },
      () => database.read('profiles', 'u1')
    );
    assert.deepEqual(result, row);
  });

  if (failed > 0) {
    console.error(`routingReadTest: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`routingReadTest: all ${passed} assertions passed ✓`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
