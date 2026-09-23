// Runnable offline test-suite for the gateway-side Story privacy rules (do.md).
// The generic /:domain routes use service-role clients (RLS bypassed), so these
// pure restrictions are the API boundary that give a non-owner viewer ONLY their
// own reaction state and keep all Story analytics owner-only.
//
// Run: npm run test:story-privacy
import assert from 'node:assert/strict';
import {
  restrictStoryReactionsRead,
  restrictStoryViewsRead,
  restrictStoryRowsRead,
  evaluateStoryReactionCreate,
  storyReactionWriteDenied,
  type QueryResultRow,
} from './storyPrivacy';

const OWNER = 'owner-uuid';
const VIEWER_B = 'viewer-b';
const VIEWER_C = 'viewer-c';

// Minimal in-memory `stories` client for the two lookups the restrictions use:
// .select('id, user_id').in('id', [...]) and .select('user_id').eq('id', x).maybeSingle()
function fakeStoriesClient(rows: Array<{ id: string; user_id: string }>) {
  return {
    from: (_table: string) => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => ({
          data: rows.filter((r) => ids.includes(r.id)),
        }),
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
  } as unknown as Parameters<typeof restrictStoryReactionsRead>[1];
}

async function main() {
  const STORY_ID = 'story-1';
  const storiesClient = fakeStoriesClient([{ id: STORY_ID, user_id: OWNER }]);

  const reactions: Array<QueryResultRow & { story_id: string; user_id: string; emoji: string }> = [
    { id: 'r1', story_id: STORY_ID, user_id: VIEWER_B, emoji: 'ok', created_at: 't1' },
    { id: 'r2', story_id: STORY_ID, user_id: VIEWER_C, emoji: 'red_heart', created_at: 't2' },
  ];

  // --- story_reactions: viewer privacy (Scenarios A/B/C/H) ---
  const ownerView = await restrictStoryReactionsRead(reactions, storiesClient, OWNER);
  assert.equal(ownerView.length, 2, 'owner keeps the full reaction list');

  const bView = await restrictStoryReactionsRead(reactions, storiesClient, VIEWER_B);
  assert.deepEqual(
    bView.map((r) => r.user_id),
    [VIEWER_B],
    'viewer only sees their own reaction'
  );

  const cView = await restrictStoryReactionsRead(reactions, storiesClient, VIEWER_C);
  assert.equal(cView.length, 1, 'non-reacting viewer sees no reactions');
  assert.equal(cView[0]?.user_id, VIEWER_C);

  const anonReactions = await restrictStoryReactionsRead(reactions, storiesClient, undefined);
  assert.equal(anonReactions.length, 0, 'anonymous viewer receives no reactions');

  const none = await restrictStoryReactionsRead([], storiesClient, VIEWER_B);
  assert.deepEqual(none, [], 'empty reaction rows are returned unchanged');

  // --- story_views: owner-only analytics (Scenarios D/E/H) ---
  const views: Array<QueryResultRow & { story_id: string; viewer_id: string }> = [
    { id: 'v1', story_id: STORY_ID, viewer_id: VIEWER_B, viewed_at: 't1' },
    { id: 'v2', story_id: STORY_ID, viewer_id: VIEWER_C, viewed_at: 't2' },
  ];

  const ownerViews = await restrictStoryViewsRead(views, storiesClient, OWNER);
  assert.equal(ownerViews.length, 2, 'owner sees all viewers');

  const viewerViews = await restrictStoryViewsRead(views, storiesClient, VIEWER_B);
  assert.equal(viewerViews.length, 0, 'viewer gets no view analytics');

  const anonViews = await restrictStoryViewsRead(views, storiesClient, undefined);
  assert.equal(anonViews.length, 0, 'anonymous reader gets no view analytics');

  // --- stories rows: view analytics redacted for non-owners (Scenario H) ---
  const ownStory = { id: 's1', user_id: OWNER, views: 127, viewed_by: [VIEWER_B, VIEWER_C] };
  const foreignStory = { id: 's2', user_id: VIEWER_B, views: 18, viewed_by: [OWNER] };

  const ownerRows = restrictStoryRowsRead([ownStory, foreignStory], OWNER);
  assert.equal(ownerRows[0]?.views, 127, "owner keeps their own story's views");
  assert.equal(ownerRows[0]?.viewed_by?.length, 2, "owner keeps their own viewed_by");
  assert.equal(ownerRows[1]?.views, undefined, 'owner never receives another story views');

  const viewerRows = restrictStoryRowsRead([ownStory, foreignStory], VIEWER_B);
  assert.equal(viewerRows[0]?.views, undefined, 'non-owner story views are redacted');
  assert.equal('viewed_by' in viewerRows[0], false, 'non-owner viewed_by is removed');
  assert.equal(viewerRows[1]?.views, 18, "a viewer keeps their OWN story's views");

  // --- owner cannot create a reaction on their own Story (Scenario F) ---
  const deniedForOwner = await evaluateStoryReactionCreate(STORY_ID, [storiesClient], OWNER);
  assert.equal(
    deniedForOwner,
    'Story owners cannot react to their own story',
    'owner self-reaction is rejected'
  );

  const allowedForViewer = await evaluateStoryReactionCreate(STORY_ID, [storiesClient], VIEWER_B);
  assert.equal(allowedForViewer, null, 'non-owner reaction is allowed');

  const deniedForBody = await storyReactionWriteDenied(
    { story_id: STORY_ID, emoji: 'ok', user_id: OWNER },
    [storiesClient],
    OWNER
  );
  assert.equal(deniedForBody, 'Story owners cannot react to their own story', 'POST body is guarded');

  const allowedForBody = await storyReactionWriteDenied(
    { story_id: STORY_ID, emoji: 'ok', user_id: VIEWER_B },
    [storiesClient],
    VIEWER_B
  );
  assert.equal(allowedForBody, null, 'viewer POST body passes');

  const unknownStory = await evaluateStoryReactionCreate('missing-story', [storiesClient], OWNER);
  assert.equal(unknownStory, null, 'unresolvable story is not blocked locally');

  const unauth = await evaluateStoryReactionCreate(STORY_ID, [storiesClient], undefined);
  assert.equal(typeof unauth, 'string', 'unauthenticated reaction is rejected');

  console.log('story privacy: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});