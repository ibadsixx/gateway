// Runnable offline test-suite for the gateway-side "Add to Highlight"
// authorization (do.md). The generic /:domain POST routes use service-role
// clients (RLS bypassed), so these guards are the API boundary that enforce:
//   - only the Story owner can add their Story to a Highlight
//   - a Story can only be added to the owner's OWN Highlight
//   - direct API/Gateway requests from anyone else are rejected (403)
//
// Run: npm run test:highlight-privacy
import assert from 'node:assert/strict';
import { evaluateHighlightItemCreate, highlightItemWriteDenied } from './highlightPrivacy';

const OWNER = 'owner-uuid';
const VIEWER_B = 'viewer-b';

// Minimal in-memory clients for the lookup the guards use:
// .select('user_id').eq('id', x).maybeSingle()
function fakeClient(rows: Array<{ id: string; user_id: string }>) {
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
  } as unknown as Parameters<typeof evaluateHighlightItemCreate>[2][number];
}

const STORY_ID = 'story-1';
const HIGHLIGHT_ID = 'highlight-1';

const storiesClient = fakeClient([{ id: STORY_ID, user_id: OWNER }]);
const highlightsClient = fakeClient([{ id: HIGHLIGHT_ID, user_id: OWNER }]);

async function main() {
  // --- Story owner adds their own Story to their own Highlight: allowed ---
  const ownerAdd = await evaluateHighlightItemCreate(
    HIGHLIGHT_ID,
    STORY_ID,
    [highlightsClient],
    [storiesClient],
    OWNER
  );
  assert.equal(ownerAdd, null, 'owner adding their own story to their own highlight is allowed');

  // --- Viewer B cannot add the owner's Story (Scenario B verification) ---
  const foreignStoryAdd = await evaluateHighlightItemCreate(
    HIGHLIGHT_ID,
    STORY_ID,
    [highlightsClient],
    [storiesClient],
    VIEWER_B
  );
  assert.equal(
    foreignStoryAdd,
    'Only the Story owner can add their Story to a Highlight',
    'a different user cannot add someone else\u2019s Story to a Highlight'
  );

  // --- Even the Story owner cannot add it to someone else's Highlight ---
  const otherHighlightClient = fakeClient([{ id: 'highlight-x', user_id: VIEWER_B }]);
  const foreignHighlightAdd = await evaluateHighlightItemCreate(
    'highlight-x',
    STORY_ID,
    [otherHighlightClient],
    [storiesClient],
    OWNER
  );
  assert.equal(
    foreignHighlightAdd,
    'You can only add Stories to your own Highlights',
    'a Story can only be added to the owner\u2019s own Highlight'
  );

  // --- Viewer B cannot add their OWN story to the owner's highlight either ---
  const bStoryClient = fakeClient([{ id: 'story-b', user_id: VIEWER_B }]);
  const bAddsToOwnersHighlight = await evaluateHighlightItemCreate(
    HIGHLIGHT_ID,
    'story-b',
    [highlightsClient],
    [bStoryClient],
    VIEWER_B
  );
  assert.equal(
    bAddsToOwnersHighlight,
    'You can only add Stories to your own Highlights',
    'owning the story is not enough — the highlight must be theirs too'
  );

  // --- POST body wrapper (single insert as the SPA sends it) ---
  const deniedBody = await highlightItemWriteDenied(
    { highlight_id: HIGHLIGHT_ID, story_id: STORY_ID },
    [highlightsClient],
    [storiesClient],
    VIEWER_B
  );
  assert.equal(
    deniedBody,
    'Only the Story owner can add their Story to a Highlight',
    'POST body is guarded for non-owners'
  );

  const allowedBody = await highlightItemWriteDenied(
    { highlight_id: HIGHLIGHT_ID, story_id: STORY_ID },
    [highlightsClient],
    [storiesClient],
    OWNER
  );
  assert.equal(allowedBody, null, 'owner POST body passes');

  // --- Unauthenticated callers are rejected up front ---
  const anon = await evaluateHighlightItemCreate(
    HIGHLIGHT_ID,
    STORY_ID,
    [highlightsClient],
    [storiesClient],
    undefined
  );
  assert.equal(typeof anon, 'string', 'unauthenticated add-to-highlight is rejected');

  // --- Unresolvable rows are left to the database (FK) constraints ---
  const unknownStory = await evaluateHighlightItemCreate(
    HIGHLIGHT_ID,
    'missing-story',
    [highlightsClient],
    [storiesClient],
    OWNER
  );
  assert.equal(unknownStory, null, 'unresolvable story is not blocked locally');

  console.log('highlight privacy: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});