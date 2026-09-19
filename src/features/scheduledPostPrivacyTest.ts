// Runnable offline test-suite for the gateway-side scheduled-post privacy
// filter (pro.md - "Scheduled"). The generic /:domain read routes use a
// service-role client (RLS bypassed), so the filter is the boundary that keeps
// another user's status='scheduled' rows out of a `/api/posts` response.
//
// Run: npm run test:scheduled-privacy
import assert from 'node:assert/strict';
import {
  isScheduledPost,
  filterScheduledPosts,
  isForeignScheduledPost,
} from './scheduledPostPrivacy';

const OWNER = 'owner-uuid';
const OTHER = 'other-uuid';

const publishedPost = { id: '1', user_id: OWNER, content: 'hi', status: 'published' };
const ownScheduled = { id: '2', user_id: OWNER, content: 'draft', status: 'scheduled' };
const foreignScheduled = { id: '3', user_id: OTHER, content: 'secret', status: 'scheduled' };

// status detection
assert.equal(isScheduledPost(publishedPost), false);
assert.equal(isScheduledPost(ownScheduled), true);
assert.equal(isScheduledPost(foreignScheduled), true);
assert.equal(isScheduledPost(null), false);
assert.equal(isScheduledPost(undefined), false);

// the owner keeps their own scheduled posts
assert.deepEqual(
  filterScheduledPosts([publishedPost, ownScheduled, foreignScheduled], OWNER),
  [publishedPost, ownScheduled],
);

// a non-owner never receives another user's scheduled posts, published posts remain
assert.deepEqual(
  filterScheduledPosts([publishedPost, ownScheduled, foreignScheduled], OTHER),
  [publishedPost, foreignScheduled],
);

// unknown/absent requester (defense in depth) sees no scheduled posts at all
assert.deepEqual(
  filterScheduledPosts([publishedPost, ownScheduled, foreignScheduled], undefined),
  [publishedPost],
);

// single-row read guard
assert.equal(isForeignScheduledPost(ownScheduled, OWNER), false);
assert.equal(isForeignScheduledPost(ownScheduled, OTHER), true);
assert.equal(isForeignScheduledPost(publishedPost, OTHER), false);
assert.equal(isForeignScheduledPost(ownScheduled, undefined), true);

console.log('scheduled-post privacy: all assertions passed');