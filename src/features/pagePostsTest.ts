// Runnable offline test-suite for the gateway-side `page_posts` authorization.
//
// The generic POST /:domain route writes with a service-role client, so RLS is
// bypassed; this guard is the API boundary that ensures only a page's admin can
// publish a post for that page, and that `shared_by` is always the caller.
//
// Run: npm run test:page-posts
import assert from 'node:assert/strict';
import { evaluatePagePostCreate, pagePostWriteDenied, stampPagePostSharedBy } from './pagePosts';

const ADMIN = 'admin-uuid';
const OTHER = 'other-uuid';
const PAGE = 'page-uuid';

// Minimal in-memory client for the lookup the guard uses:
// .from('pages').select('admin_id').eq('id', x).maybeSingle()
function fakeClient(rows: Array<{ id: string; admin_id: string }>) {
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: (_col: string, id: string) => ({
          maybeSingle: async () => {
            const row = rows.find((r) => r.id === id);
            return row
              ? { data: row, error: null }
              : { data: null, error: { message: 'PGRST116 - No rows found' } };
          },
        }),
      }),
    }),
  } as unknown as Parameters<typeof evaluatePagePostCreate>[2][number];
}

const pages = [fakeClient([{ id: PAGE, admin_id: ADMIN }])];

async function main() {
  // The page admin can publish for their own page.
  const adminOk = await evaluatePagePostCreate(PAGE, ADMIN, pages, ADMIN);
  assert.equal(adminOk, null, 'the page admin may publish a post for the page');

  // A non-admin cannot associate a post with someone else's page.
  const nonAdmin = await evaluatePagePostCreate(PAGE, OTHER, pages, OTHER);
  assert.equal(
    nonAdmin,
    'You can only publish posts for pages you manage',
    'a non-admin cannot publish a post for a page they do not manage'
  );

  // A non-admin cannot spoof `shared_by` to the admin either.
  const spoofed = await evaluatePagePostCreate(PAGE, ADMIN, pages, OTHER);
  assert.equal(
    typeof spoofed,
    'string',
    'a caller cannot attribute a page post to another user'
  );

  // A body that claims `shared_by` = someone else is denied for the real caller.
  const spoofBody = await pagePostWriteDenied(
    { page_id: PAGE, shared_by: ADMIN },
    pages,
    OTHER
  );
  assert.equal(typeof spoofBody, 'string', 'spoofed shared_by in the POST body is rejected');

  // The real admin's POST body passes.
  const allowedBody = await pagePostWriteDenied(
    { page_id: PAGE, post_id: 'post-1', shared_by: ADMIN },
    pages,
    ADMIN
  );
  assert.equal(allowedBody, null, 'the page admin POST body passes');

  // Unauthenticated callers are rejected up front.
  const anon = await evaluatePagePostCreate(PAGE, undefined, pages, undefined);
  assert.equal(typeof anon, 'string', 'unauthenticated page-post writes are rejected');

  // A body with no usable page id is rejected before any lookup.
  const noPage = await evaluatePagePostCreate(undefined, ADMIN, pages, ADMIN);
  assert.equal(typeof noPage, 'string', 'a missing page id is rejected');

  // Unresolvable pages are left to the database (FK) constraint.
  const unknownPage = await evaluatePagePostCreate('missing-page', ADMIN, pages, ADMIN);
  assert.equal(unknownPage, null, 'unresolvable pages are not blocked locally');

  // An array body is guarded row-by-row.
  const bulkDenied = await pagePostWriteDenied(
    [
      { page_id: PAGE, shared_by: ADMIN },
      { page_id: PAGE, shared_by: OTHER },
    ],
    pages,
    OTHER
  );
  assert.equal(typeof bulkDenied, 'string', 'a denied row in a bulk write rejects the batch');

  // `shared_by` is always stamped to the authenticated caller.
  const payload: Record<string, unknown> = { page_id: PAGE, shared_by: OTHER };
  stampPagePostSharedBy(payload, ADMIN);
  assert.equal(payload.shared_by, ADMIN, 'shared_by is stamped to the authenticated caller');

  const bulk: Array<Record<string, unknown>> = [{ page_id: PAGE, shared_by: OTHER }];
  stampPagePostSharedBy(bulk, ADMIN);
  assert.equal(bulk[0].shared_by, ADMIN, 'array rows are stamped too');

  console.log('page posts authorization: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
