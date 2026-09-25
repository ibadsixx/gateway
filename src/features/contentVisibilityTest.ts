// Runnable offline regression suite for the Friends-audience bug (do.md,
// "Fix the critical Friends-audience privacy bug for posts, reels, photos").
//
// Two independent defects produced the two reported symptoms:
//
//   1. "sometimes visible to EVERYONE" — the generic GET /:domain and
//      GET /:domain/:id routes read `posts` with a service-role client, which
//      BYPASSES the `Posts are viewable based on audience and status` RLS
//      policy. Nothing read `audience_type` for an authenticated viewer, so a
//      friends/only_me row was serialized (media URL included) to any caller.
//
//   2. "sometimes visible ONLY TO THE OWNER, as if it were Only me" — the
//      audience evaluators consulted the legacy `visibility` column BEFORE
//      `audience_type` and returned false for any non-'public' `visibility`.
//      The reel composer wrote BOTH columns with the same value, so a Friends
//      reel (`audience_type='friends'`, `visibility='friends'`) was denied
//      before the `friends` friendship check ever ran.
//
// The matrix below is A (owner) / B (accepted friend) / C (non-friend) /
// Guest, over post, reel and photo, then the Public and Only-me changes.
//
// Run: npm run test:content-visibility
import assert from 'node:assert/strict';
import {
  canViewerViewPost,
  canonicalAudienceType,
  resolveContentAudience,
  isPublicContent,
  DENIED_AUDIENCE,
} from './reactionUsers';
import {
  filterContentRowsForViewer,
  resolveViewerFriendIds,
  canViewerReadContentRow,
} from './contentVisibility';

const OWNER = 'owner-uuid';
const FRIEND = 'accepted-friend-uuid';
const STRANGER = 'non-friend-uuid';
const PENDING = 'pending-request-uuid';

const VISIBLE = true;
const HIDDEN = false;

// A guest has no session id. A guest is never a friend, for any audience.
const GUEST = undefined;

// The accepted-friendship set is the VIEWER's, so it is per-viewer: A's set
// holds B, and B's set holds A.
const OWNER_FRIENDS = new Set<string>([FRIEND]);
const FRIEND_FRIENDS = new Set<string>([OWNER]);
const STRANGER_FRIENDS = new Set<string>();
// A viewer with only a PENDING request in the other direction. Pending
// requests must not grant access.
const PENDING_FRIENDS = new Set<string>();

type ContentKind = 'post' | 'reel' | 'photo';
const KINDS: ContentKind[] = ['post', 'reel', 'photo'];

// The three audiences the UI exposes, in both the modern (`audience_type`)
// and the legacy-column shape that the reel composer used to write.
function makeContent(
  kind: ContentKind,
  audience: 'public' | 'friends' | 'only_me',
  options: { legacyVisibility?: string | null; status?: string } = {}
): Record<string, unknown> {
  const { legacyVisibility, status = 'published' } = options;
  return {
    id: `${kind}-${audience}`,
    user_id: OWNER,
    type: kind === 'reel' ? 'reel' : kind === 'photo' ? 'profile_picture_update' : 'normal_post',
    media_url: 'https://cdn.example/media/secret.mp4',
    content: 'private words',
    audience_type: audience,
    // `legacyVisibility` reproduces the old composite row (both columns set
    // to the same value) that triggered the owner-only symptom.
    visibility: legacyVisibility === undefined ? null : legacyVisibility,
    status,
  };
}

console.log('[content-visibility] A. Friends audience — owner / friend / non-friend / guest');

for (const kind of KINDS) {
  const friends = makeContent(kind, 'friends');
  // The exact row shape the reel composer used to write: visibility shadowed
  // audience_type and collapsed Friends to owner-only.
  const friendsWithLegacyVisibility = makeContent(kind, 'friends', { legacyVisibility: 'friends' });

  for (const [label, row] of [
    ['audience_type only', friends],
    ['audience_type + legacy visibility', friendsWithLegacyVisibility],
  ] as Array<[string, Record<string, unknown>]>) {
    // A. owner (A) always sees their own Friends content.
    assert.equal(canViewerViewPost(row, OWNER, OWNER_FRIENDS), VISIBLE, `${kind} ${label}: A owner`);
    // B. accepted friend sees it — this is the regression that failed before.
    assert.equal(canViewerViewPost(row, FRIEND, FRIEND_FRIENDS), VISIBLE, `${kind} ${label}: B friend`);
    // C. authenticated non-friend never sees it.
    assert.equal(canViewerViewPost(row, STRANGER, STRANGER_FRIENDS), HIDDEN, `${kind} ${label}: C non-friend`);
    // C'. a viewer with only a PENDING request is still a non-friend.
    assert.equal(canViewerViewPost(row, PENDING, PENDING_FRIENDS), HIDDEN, `${kind} ${label}: pending`);
    // Guest is never a friend, even for a public row (checked below) and
    // never for Friends content.
    assert.equal(canViewerViewPost(row, GUEST, new Set()), HIDDEN, `${kind} ${label}: guest`);
  }

  // A guest never receives a friends-only row through the list filter either.
  assert.deepEqual(
    filterContentRowsForViewer([friends], GUEST, new Set()),
    [],
    `${kind}: guest list filter`
  );
}

console.log('[content-visibility] B. Public audience — everyone including guests');

for (const kind of KINDS) {
  const pub = makeContent(kind, 'public');
  assert.equal(canViewerViewPost(pub, OWNER, OWNER_FRIENDS), VISIBLE, `${kind}: A owner`);
  assert.equal(canViewerViewPost(pub, FRIEND, FRIEND_FRIENDS), VISIBLE, `${kind}: B friend`);
  assert.equal(canViewerViewPost(pub, STRANGER, STRANGER_FRIENDS), VISIBLE, `${kind}: C non-friend`);
  assert.equal(canViewerViewPost(pub, GUEST, new Set()), VISIBLE, `${kind}: guest`);
  // Public discovery surfaces keep public-only.
  assert.equal(isPublicContent(pub), true, `${kind}: public discovery`);
  assert.deepEqual(filterContentRowsForViewer([pub], GUEST, new Set()), [pub], `${kind}: guest list`);

  // A row with no audience_type at all is public (the column DEFAULT).
  const legacyPublic = { ...pub, audience_type: null, visibility: null };
  assert.equal(canViewerViewPost(legacyPublic, STRANGER, STRANGER_FRIENDS), VISIBLE, `${kind}: legacy public`);
  assert.equal(canViewerViewPost(legacyPublic, GUEST, new Set()), VISIBLE, `${kind}: legacy public guest`);

  // A public row that excludes a specific viewer keeps them out.
  const excluded = { ...pub, audience_excluded_user_ids: [STRANGER] };
  assert.equal(canViewerViewPost(excluded, STRANGER, STRANGER_FRIENDS), HIDDEN, `${kind}: excluded viewer`);
  assert.equal(canViewerViewPost(excluded, FRIEND, FRIEND_FRIENDS), VISIBLE, `${kind}: non-excluded viewer`);
}

console.log('[content-visibility] C. Only me — owner only, for every viewer kind');

for (const kind of KINDS) {
  const onlyMe = makeContent(kind, 'only_me');
  const onlyMeLegacy = makeContent(kind, 'only_me', { legacyVisibility: 'only_me' });
  for (const row of [onlyMe, onlyMeLegacy]) {
    assert.equal(canViewerViewPost(row, OWNER, OWNER_FRIENDS), VISIBLE, `${kind}: A owner`);
    assert.equal(canViewerViewPost(row, FRIEND, FRIEND_FRIENDS), HIDDEN, `${kind}: B friend denied`);
    assert.equal(canViewerViewPost(row, STRANGER, STRANGER_FRIENDS), HIDDEN, `${kind}: C non-friend denied`);
    assert.equal(canViewerViewPost(row, GUEST, new Set()), HIDDEN, `${kind}: guest denied`);
    assert.equal(isPublicContent(row), false, `${kind}: not in public discovery`);
  }
}

console.log('[content-visibility] D. Own unpublished content stays author-only');

for (const kind of KINDS) {
  for (const status of ['draft', 'scheduled']) {
    const row = makeContent(kind, 'public', { status });
    assert.equal(canViewerViewPost(row, OWNER, OWNER_FRIENDS), VISIBLE, `${kind} ${status}: owner`);
    assert.equal(canViewerViewPost(row, FRIEND, FRIEND_FRIENDS), HIDDEN, `${kind} ${status}: friend`);
    assert.equal(canViewerViewPost(row, STRANGER, STRANGER_FRIENDS), HIDDEN, `${kind} ${status}: non-friend`);
    assert.equal(canViewerViewPost(row, GUEST, new Set()), HIDDEN, `${kind} ${status}: guest`);
  }
}

console.log('[content-visibility] E. Other audiences keep their existing rules');

const friendsExcept = {
  ...makeContent('post', 'friends_except' as any),
  audience_type: 'friends_except',
  audience_excluded_user_ids: [FRIEND],
};
assert.equal(canViewerViewPost(friendsExcept, OWNER, OWNER_FRIENDS), VISIBLE, 'friends_except: owner');
assert.equal(canViewerViewPost(friendsExcept, STRANGER, STRANGER_FRIENDS), HIDDEN, 'friends_except: non-friend');
// The excluded viewer IS an accepted friend but is named in the exclusion list.
assert.equal(canViewerViewPost(friendsExcept, FRIEND, FRIEND_FRIENDS), HIDDEN, 'friends_except: excluded friend');
assert.equal(isPublicContent(friendsExcept), false, 'friends_except: not public');

const specific = {
  ...makeContent('post', 'public'),
  audience_type: 'specific',
  audience_user_ids: [FRIEND],
};
assert.equal(canViewerViewPost(specific, OWNER, OWNER_FRIENDS), VISIBLE, 'specific: owner');
assert.equal(canViewerViewPost(specific, FRIEND, FRIEND_FRIENDS), VISIBLE, 'specific: listed viewer');
assert.equal(canViewerViewPost(specific, STRANGER, STRANGER_FRIENDS), HIDDEN, 'specific: unlisted viewer');
assert.equal(canViewerViewPost(specific, GUEST, new Set()), HIDDEN, 'specific: guest');

// custom_list needs a list-membership reader that does not exist here, so it
// must fail closed rather than leak.
const customList = { ...makeContent('post', 'public'), audience_type: 'custom_list' };
assert.equal(canViewerViewPost(customList, OWNER, OWNER_FRIENDS), VISIBLE, 'custom_list: owner');
assert.equal(canViewerViewPost(customList, FRIEND, FRIEND_FRIENDS), HIDDEN, 'custom_list: fails closed');
assert.equal(isPublicContent(customList), false, 'custom_list: not public');

console.log('[content-visibility] F. Audience normalization and fail-closed behavior');

// Stored values may be cased/spaced differently; they must still resolve.
for (const stored of ['friends', 'Friends', 'FRIENDS', ' friends ', 'friends_only', 'friends-only', 'friend']) {
  assert.equal(canonicalAudienceType(stored), 'friends', `normalizes ${JSON.stringify(stored)}`);
}
for (const stored of ['public', 'Public', 'PUBLIC', ' everyone ', 'anyone']) {
  assert.equal(canonicalAudienceType(stored), 'public', `normalizes ${JSON.stringify(stored)}`);
}
for (const stored of ['only_me', 'onlyMe', 'only-me', 'private', ' Only Me ']) {
  assert.equal(canonicalAudienceType(stored), 'only_me', `normalizes ${JSON.stringify(stored)}`);
}
// Absent values mean "fall back to the other column", not "deny".
assert.equal(canonicalAudienceType(null), null);
assert.equal(canonicalAudienceType(undefined), null);
assert.equal(canonicalAudienceType(''), null);
assert.equal(canonicalAudienceType('   '), null);
// An unrecognized stored value must fail closed.
assert.equal(canonicalAudienceType('secret_handshake'), DENIED_AUDIENCE);

// audience_type is authoritative and is never shadowed by `visibility`.
assert.equal(
  resolveContentAudience({ audience_type: 'friends', visibility: 'only_me' }),
  'friends',
  'audience_type wins over visibility'
);
assert.equal(
  resolveContentAudience({ audience_type: 'public', visibility: 'friends' }),
  'public',
  'audience_type wins over visibility (public)'
);
// Legacy rows with only `visibility` still resolve.
assert.equal(resolveContentAudience({ visibility: 'friends' }), 'friends', 'legacy visibility friends');
assert.equal(resolveContentAudience({ visibility: 'private' }), 'only_me', 'legacy visibility private');
assert.equal(resolveContentAudience({}), 'public', 'no audience columns -> public');
// An unrecognized value in either column denies.
assert.equal(
  canViewerViewPost({ user_id: OWNER, audience_type: 'wat', status: 'published' }, STRANGER, STRANGER_FRIENDS),
  HIDDEN,
  'unrecognized audience_type fails closed'
);
assert.equal(
  canViewerViewPost({ user_id: OWNER, visibility: 'wat', status: 'published' }, STRANGER, STRANGER_FRIENDS),
  HIDDEN,
  'unrecognized legacy visibility fails closed'
);

console.log('[content-visibility] G. List filter: mixed response, per viewer');

const mixedResponse = [
  { id: 'p1', user_id: OWNER, audience_type: 'public', status: 'published' },
  { id: 'p2', user_id: OWNER, audience_type: 'friends', status: 'published' },
  { id: 'p3', user_id: OWNER, audience_type: 'only_me', status: 'published' },
  { id: 'p4', user_id: STRANGER, audience_type: 'public', status: 'published' },
  { id: 'p5', user_id: OWNER, audience_type: 'friends', status: 'scheduled' },
  // A legacy row whose legacy column still says friends.
  { id: 'p6', user_id: OWNER, audience_type: 'friends', visibility: 'friends', status: 'published' },
];

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

assert.deepEqual(
  ids(filterContentRowsForViewer(mixedResponse, OWNER, OWNER_FRIENDS)),
  ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
  'owner sees all of their own content, plus other people public rows'
);
assert.deepEqual(
  ids(filterContentRowsForViewer(mixedResponse, FRIEND, FRIEND_FRIENDS)),
  ['p1', 'p2', 'p4', 'p6'],
  'accepted friend sees public + friends, never only_me or another user scheduled'
);
assert.deepEqual(
  ids(filterContentRowsForViewer(mixedResponse, STRANGER, STRANGER_FRIENDS)),
  ['p1', 'p4'],
  'non-friend sees public only'
);
assert.deepEqual(
  ids(filterContentRowsForViewer(mixedResponse, GUEST, new Set())),
  ['p1', 'p4'],
  'guest sees public only'
);

console.log('[content-visibility] H. Single-row read (direct /post/:id)');

const friendsSingle = makeContent('post', 'friends');
assert.equal(canViewerReadContentRow(friendsSingle, OWNER, OWNER_FRIENDS), VISIBLE, 'single: owner');
assert.equal(canViewerReadContentRow(friendsSingle, FRIEND, FRIEND_FRIENDS), VISIBLE, 'single: friend');
assert.equal(canViewerReadContentRow(friendsSingle, STRANGER, STRANGER_FRIENDS), HIDDEN, 'single: non-friend 404');
assert.equal(canViewerReadContentRow(friendsSingle, GUEST, new Set()), HIDDEN, 'single: guest 404');
assert.equal(canViewerReadContentRow(null, STRANGER, STRANGER_FRIENDS), HIDDEN, 'single: missing row');
assert.equal(
  canViewerReadContentRow(makeContent('post', 'only_me'), FRIEND, FRIEND_FRIENDS),
  HIDDEN,
  'single: only_me never resolves for a non-owner'
);

console.log('[content-visibility] I. Accepted-friendship resolution (service-role read)');

async function runFriendshipResolutionChecks(): Promise<void> {
  // The friend set is resolved from the `friends` table by the authenticated
  // session id only. A guest resolves to the empty set without querying.
  assert.deepEqual(await resolveViewerFriendIds(GUEST, []), new Set(), 'guest resolves no friends');

  const fakeFriendsClient = {
    from(table: string) {
      assert.equal(table, 'friends', 'friend resolution reads the friends table');
      const builder: Record<string, unknown> = {
        select: () => builder,
        or: (value: string) => {
          assert.ok(
            value.includes(`requester_id.eq.${OWNER}`) && value.includes(`receiver_id.eq.${OWNER}`),
            'friend resolution is scoped to the authenticated session id'
          );
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            data: [
              { requester_id: OWNER, receiver_id: FRIEND, status: 'accepted' },
              { requester_id: OWNER, receiver_id: PENDING, status: 'pending' },
              { requester_id: OWNER, receiver_id: STRANGER, status: 'rejected' },
            ],
            error: null,
          }),
      };
      return builder;
    },
  };

  const resolved = await resolveViewerFriendIds(OWNER, [{ client: fakeFriendsClient } as any]);
  assert.deepEqual(resolved, new Set([FRIEND]), 'only accepted friendships are resolved');
  assert.ok(
    !resolved.has(PENDING) && !resolved.has(STRANGER),
    'pending and rejected relationships never grant access'
  );

  // A read error resolves to the empty set, which can only deny friends content.
  const failingClient = {
    from: () => ({
      select: () => ({
        or: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
      }),
    }),
  };
  assert.deepEqual(
    await resolveViewerFriendIds(OWNER, [{ client: failingClient } as any]),
    new Set(),
    'friend resolution fails closed'
  );

  console.log('content-visibility: all assertions passed');
}

runFriendshipResolutionChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
