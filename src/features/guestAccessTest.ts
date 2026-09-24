// Runnable offline test-suite for the Gateway guest/public-read policy (do.md:
// "Public access" round). The generic GET routes use service-role clients (RLS
// bypassed), so these pure rules are the API boundary that give a logged-out
// visitor ONLY published public content — never private posts, private profile
// fields, or rows scoped to non-public parents.
//
// Run: npm run test:guest-access
import assert from 'node:assert/strict';
import {
  GUEST_READ_DOMAINS,
  isGuestReadableDomain,
  isGuestPostVisible,
  filterGuestPosts,
  isGuestGroupVisible,
  stripPrivateProfileFields,
  filterGuestPostScopedRows,
  filterGuestGroupScopedRows,
  applyGuestReadPolicy,
  filterAuthenticatedProfileListRows,
  isGuestSingleRowVisible,
  stripGuestSingleRowRead,
  type GuestReadableRow,
} from './guestAccess';

const PUBLISHED_PUBLIC_POST: GuestReadableRow = {
  id: 'post-1',
  user_id: 'author-1',
  visibility: 'public',
  audience_type: 'public',
  status: 'published',
};

// Minimal in-memory client for the two parent lookups the scoped filters use:
// .from(table).select('*').in('id', ids)
function fakeClient(rows: GuestReadableRow[]) {
  return {
    from: (_table: string) => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => ({
          data: rows.filter((r) => ids.includes(String(r.id))),
          error: null,
        }),
      }),
    }),
  } as unknown as Parameters<typeof filterGuestPostScopedRows>[1];
}

// Client for the AUTHENTICATED profile-list gate tests: serves profile rows for
// the `.select('*').in('id', ids)` subject lookups AND answers the friends
// domain's accepted-friendship check (`.select('id').or(expr).eq('status',
// 'accepted').maybeSingle()`) against the given friendship rows.
function authClient(options: { profiles?: GuestReadableRow[]; friendships?: GuestReadableRow[] } = {}) {
  const profiles = options.profiles || [];
  const friendships = options.friendships || [];
  return {
    from: (_table: string) => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => ({
          data: profiles.filter((r) => ids.includes(String(r.id))),
          error: null,
        }),
        or: (expr: string) => ({
          eq: (_col: string, _val: unknown) => ({
            maybeSingle: async () => {
              for (const t of expr.match(/and\(\w+\.eq\.[^,]+,\w+\.eq\.[^)]+\)/g) || []) {
                const m = t.match(/^and\((\w+)\.eq\.([^,]+),(\w+)\.eq\.([^)]+)\)$/);
                if (!m) continue;
                const [, ca, va, cb, vb] = m;
                const hit = friendships.some(
                  (f: any) =>
                    (f[ca] === va && f[cb] === vb && f.status === 'accepted') ||
                    (f[ca] === vb && f[cb] === va && f.status === 'accepted')
                );
                if (hit) return { data: { id: 'edge' }, error: null };
              }
              return { data: null, error: null };
            },
          }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof filterAuthenticatedProfileListRows>[2];
}

async function main(): Promise<void> {
  // --- domain allowlist ---
  for (const domain of ['posts', 'profiles', 'groups', 'pages', 'hashtags', 'page_posts', 'group_posts', 'group_members', 'likes', 'comments', 'post_tags', 'hashtag_links', 'profile_details', 'other_names', 'life_events', 'family_relationships', 'companies', 'colleges', 'high_schools', 'friends', 'followers']) {
    assert.equal(isGuestReadableDomain(domain), true, `guest may read ${domain}`);
  }
  assert.equal(GUEST_READ_DOMAINS.size, 21, 'exactly the public-surface domains are guest-readable');
  for (const denied of ['stories', 'story_views', 'story_reactions', 'story_highlights', 'message_requests', 'messages', 'conversations', 'notifications', 'privacy_settings', 'hidden_content', 'saved_posts', 'group_follows', 'group_pins', 'post_shares', 'blocks']) {
    assert.equal(isGuestReadableDomain(denied), false, `guest is denied ${denied}`);
  }

  // --- posts ---
  assert.equal(isGuestPostVisible(PUBLISHED_PUBLIC_POST), true, 'published public post is guest-visible');
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, visibility: 'friends' }),
    false,
    'friends-only post is not guest-visible'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, visibility: 'private' }),
    false,
    'private post is not guest-visible'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, audience_type: 'only_me' }),
    false,
    'only_me audience is not guest-visible'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, audience_type: 'specific', audience_user_ids: ['x'] }),
    false,
    'specific audience is not guest-visible'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, audience_type: 'friends' }),
    false,
    'friends audience is not guest-visible'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, status: 'draft' }),
    false,
    'draft post is not guest-visible'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, status: 'scheduled' }),
    false,
    'scheduled post is not guest-visible'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, status: null }),
    true,
    'null status is treated as published'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, visibility: null, audience_type: null }),
    true,
    'null visibility/audience defaults to public (matches app filter)'
  );
  assert.equal(
    isGuestPostVisible({ ...PUBLISHED_PUBLIC_POST, type: 'reel' }),
    true,
    'public reel (post type reel) is guest-visible'
  );
  assert.equal(isGuestPostVisible(null), false, 'null row is not visible');
  assert.equal(isGuestPostVisible(undefined), false, 'undefined row is not visible');

  const filtered = filterGuestPosts([
    PUBLISHED_PUBLIC_POST,
    { ...PUBLISHED_PUBLIC_POST, id: 'p2', visibility: 'friends' },
    { ...PUBLISHED_PUBLIC_POST, id: 'p3', status: 'draft' },
    { ...PUBLISHED_PUBLIC_POST, id: 'p4', audience_type: 'only_me' },
  ]);
  assert.deepEqual(filtered.map((p) => p.id), ['post-1'], 'only the public published post survives');

  // --- groups ---
  assert.equal(isGuestGroupVisible({ id: 'g1', privacy: 'public' }), true, 'public group is guest-visible');
  assert.equal(isGuestGroupVisible({ id: 'g2', privacy: 'closed' }), false, 'closed group is not guest-visible');
  assert.equal(isGuestGroupVisible({ id: 'g3', privacy: 'private' }), false, 'private group is not guest-visible');
  assert.equal(isGuestGroupVisible({ id: 'g4' }), false, 'group without privacy is not guest-visible');

  // --- profile redaction ---
  const profile: GuestReadableRow = {
    id: 'u1',
    username: 'alice',
    display_name: 'Alice',
    profile_pic: 'https://media/pic.jpg',
    email: 'alice@example.com',
    email_visibility: 'private',
    phone_number: '+1',
    phone_visibility: 'friends',
    birth_date: '1990-01-01',
    birth_date_visibility: null,
    websites_social_links: ['x'],
    websites_visibility: 'public',
    relationship_status: 'married',
    relationship_visibility: 'friends',
    vault_pin: '1234',
    vault_recovery_code: 'secret',
    preview_mode: true,
    last_seen_at: '2026-09-23T10:00:00Z',
  };
  const redacted = stripPrivateProfileFields(profile);
  assert.equal(redacted.email, null, 'email with private visibility is stripped');
  assert.equal(redacted.phone_number, null, 'phone with friends visibility is stripped');
  assert.equal(redacted.birth_date, '1990-01-01', 'birth_date with null visibility (public default) is kept');
  assert.deepEqual(redacted.websites_social_links, ['x'], 'public websites are kept');
  assert.equal(redacted.relationship_status, null, 'relationship_status with friends visibility is stripped');
  assert.equal((redacted as GuestReadableRow).relationship_visibility, 'friends', 'relationship visibility flag stays intact');
  assert.equal(redacted.vault_pin, null, 'vault_pin is always stripped');
  assert.equal(redacted.vault_recovery_code, null, 'vault_recovery_code is always stripped');
  assert.equal(redacted.preview_mode, null, 'preview_mode is always stripped');
  assert.equal(redacted.username, 'alice', 'username is kept');
  assert.equal(redacted.display_name, 'Alice', 'display_name is kept');
  assert.equal(redacted.profile_pic, 'https://media/pic.jpg', 'profile_pic is kept');
  assert.equal((redacted as GuestReadableRow).email_visibility, 'private', 'visibility flags stay intact for UI gating');

  // --- parent-scoped rows ---
  const publicPostClient = fakeClient([PUBLISHED_PUBLIC_POST]);
  const likesOnPublic = [
    { id: 'l1', post_id: 'post-1', user_id: 'u1' },
    { id: 'l2', post_id: 'post-1', user_id: 'u2' },
  ];
  const likesScoped = await filterGuestPostScopedRows(likesOnPublic, publicPostClient);
  assert.equal(likesScoped.length, 2, 'likes on a public post are guest-readable');

  const privatePostClient = fakeClient([{ ...PUBLISHED_PUBLIC_POST, visibility: 'friends' }]);
  const commentsOnPrivate = [{ id: 'c1', post_id: 'post-1', content: 'secret comment' }];
  const commentsScoped = await filterGuestPostScopedRows(commentsOnPrivate, privatePostClient);
  assert.equal(commentsScoped.length, 0, 'comments on a non-public post are NOT guest-readable');

  const tagsScoped = await filterGuestPostScopedRows(
    [{ id: 't1', post_id: 'post-1', tag: 'x' }],
    privatePostClient
  );
  assert.equal(tagsScoped.length, 0, 'post_tags on a non-public post are NOT guest-readable');

  // hashtag_links uses source_id instead of post_id
  const hashtagLinksPublic = await filterGuestPostScopedRows(
    [{ id: 'hl1', hashtag_id: 'h1', source_id: 'post-1', source_type: 'post' }],
    publicPostClient,
    'source_id'
  );
  assert.equal(hashtagLinksPublic.length, 1, 'hashtag_links of a public post are guest-readable');
  const hashtagLinksPrivate = await filterGuestPostScopedRows(
    [{ id: 'hl2', hashtag_id: 'h1', source_id: 'post-1', source_type: 'post' }],
    privatePostClient,
    'source_id'
  );
  assert.equal(hashtagLinksPrivate.length, 0, 'hashtag_links of a non-public post are NOT guest-readable');

  const publicGroupClient = fakeClient([{ id: 'g1', privacy: 'public' }]);
  const groupPostsPublic = await filterGuestGroupScopedRows([{ id: 'gp1', group_id: 'g1' }], publicGroupClient);
  assert.equal(groupPostsPublic.length, 1, 'group_posts of a public group are guest-readable');
  const groupMembersPublic = await filterGuestGroupScopedRows([{ id: 'gm1', group_id: 'g1' }], publicGroupClient);
  assert.equal(groupMembersPublic.length, 1, 'group_members of a public group are guest-readable');

  const closedGroupClient = fakeClient([{ id: 'g2', privacy: 'closed' }]);
  const groupPostsClosed = await filterGuestGroupScopedRows([{ id: 'gp2', group_id: 'g2' }], closedGroupClient);
  assert.equal(groupPostsClosed.length, 0, 'group_posts of a closed group are NOT guest-readable');
  const groupMembersClosed = await filterGuestGroupScopedRows([{ id: 'gm2', group_id: 'g2' }], closedGroupClient);
  assert.equal(groupMembersClosed.length, 0, 'group_members of a closed group are NOT guest-readable');

  // --- applyGuestReadPolicy dispatch ---
  const posts = await applyGuestReadPolicy('posts', [PUBLISHED_PUBLIC_POST, { ...PUBLISHED_PUBLIC_POST, visibility: 'private' }], publicPostClient);
  assert.equal(posts.length, 1, 'posts policy filters to public');
  const profs = await applyGuestReadPolicy('profiles', [profile], publicPostClient);
  assert.equal(profs[0]?.email, null, 'profiles policy redacts');
  const groups = await applyGuestReadPolicy('groups', [{ privacy: 'public' }, { privacy: 'private' }], publicPostClient);
  assert.equal(groups.length, 1, 'groups policy filters to public');
  const pages = await applyGuestReadPolicy('pages', [{ id: 'pg1' }], publicPostClient);
  assert.equal(pages.length, 1, 'pages policy passes through');
  const hashtags = await applyGuestReadPolicy('hashtags', [{ id: 'h1', tag: 'x' }], publicPostClient);
  assert.equal(hashtags.length, 1, 'hashtags policy passes through');
  const unknownPolicy = await applyGuestReadPolicy('stories', [{ id: 's1' }], publicPostClient);
  assert.equal(unknownPolicy.length, 0, 'non-allowlisted domain yields no rows');

  // --- profile About content domains (do.md: guests see ALL public info) ---
  const otherNames = await applyGuestReadPolicy('other_names', [
    { id: 'on1', user_id: 'u1', type: 'nickname', name: 'Ali', visibility: 'public' },
    { id: 'on2', user_id: 'u1', type: 'nickname', name: 'Ali2', visibility: 'friends' },
    { id: 'on3', user_id: 'u1', type: 'nickname', name: 'Ali3', visibility: 'private' },
  ], publicPostClient);
  assert.deepEqual(otherNames.map((r) => r.id), ['on1'], 'other_names keeps public rows only');

  const lifeEvents = await applyGuestReadPolicy('life_events', [
    { id: 'le1', user_id: 'u1', category: 'Travel & Living', title: 'Moved to Paris', visibility: 'public' },
    { id: 'le2', user_id: 'u1', category: 'Work & Education', title: 'Grad school', visibility: 'friends' },
  ], publicPostClient);
  assert.deepEqual(lifeEvents.map((r) => r.id), ['le1'], 'life_events keeps public rows only');

  const familyRelationships = await applyGuestReadPolicy('family_relationships', [
    { id: 'fr1', user_id: 'u1', member_id: 'u2', relation_type: 'sister', visibility: 'public' },
    { id: 'fr2', user_id: 'u1', member_id: 'u3', relation_type: 'brother', visibility: 'friends' },
  ], publicPostClient);
  assert.deepEqual(familyRelationships.map((r) => r.id), ['fr1'], 'family_relationships keeps public rows only');

  const profileDetails = await applyGuestReadPolicy('profile_details', [
    { id: 'pd1', profile_id: 'u1', section: 'places', field_name: 'current_city', field_value: 'Paris' },
  ], publicPostClient);
  assert.equal(profileDetails.length, 1, 'profile_details passes through (no per-row visibility)');

  const companies = await applyGuestReadPolicy('companies', [{ id: 'c1', name: 'Acme' }], publicPostClient);
  assert.equal(companies.length, 1, 'companies reference table passes through');
  const colleges = await applyGuestReadPolicy('colleges', [{ id: 'cl1', name: 'MIT' }], publicPostClient);
  assert.equal(colleges.length, 1, 'colleges reference table passes through');
  const highSchools = await applyGuestReadPolicy('high_schools', [{ id: 'hs1', name: 'Lincoln HS' }], publicPostClient);
  assert.equal(highSchools.length, 1, 'high_schools reference table passes through');

  // --- profile lists (do.md): friends / following / followers, gated by the
  // --- viewed profile owner's per-list visibility ---
  const friendsPublicClient = fakeClient([{ id: 'x1', friends_visibility: 'public' }]);
  const friendsHiddenClient = fakeClient([{ id: 'x1', friends_visibility: 'friends' }]);
  const friendsRows = [
    { id: 'f1', requester_id: 'x1', receiver_id: 'y1', status: 'accepted' },
    { id: 'f2', requester_id: 'z1', receiver_id: 'x1', status: 'accepted' },
  ];
  const friendsListFilters = ['or=(requester_id.eq.x1,receiver_id.eq.x1)', 'status=eq.accepted'];

  const friendsPublic = await applyGuestReadPolicy('friends', friendsRows, friendsPublicClient, friendsListFilters);
  assert.equal(friendsPublic.length, 2, 'friends list rows are guest-readable when friends_visibility is public');

  const friendsHidden = await applyGuestReadPolicy('friends', friendsRows, friendsHiddenClient, friendsListFilters);
  assert.equal(friendsHidden.length, 0, 'friends list rows are hidden when friends_visibility is not public');

  const followingPublicClient = fakeClient([{ id: 'x1', following_visibility: true }]);
  const followingHiddenClient = fakeClient([{ id: 'x1', following_visibility: false }]);
  const followingNullClient = fakeClient([{ id: 'x1' }]);

  // Following list (row pinned by follower_id): gated on the follower profile's
  // following_visibility — the existing Follow-graph toggle keeps controlling it.
  const followingRows = [{ id: 'fl1', follower_id: 'x1', following_id: 'y1' }];
  const followingOk = await applyGuestReadPolicy('followers', followingRows, followingPublicClient, ['follower_id=eq.x1']);
  assert.equal(followingOk.length, 1, 'following list (follower_id pin) is guest-readable when following_visibility is true');
  const followingBlocked = await applyGuestReadPolicy('followers', followingRows, followingHiddenClient, ['follower_id=eq.x1']);
  assert.equal(followingBlocked.length, 0, 'following list is hidden when following_visibility is false');

  // Followers list (row pinned by following_id): ALWAYS guest-visible — do.md
  // requires the Followers list to stay visible to guests. It is NOT coupled to
  // following_visibility (Following and Followers are separate lists).
  const followersRows = [{ id: 'fs1', follower_id: 'y1', following_id: 'x1' }];
  const followersOk = await applyGuestReadPolicy('followers', followersRows, followingPublicClient, ['following_id=eq.x1']);
  assert.equal(followersOk.length, 1, 'followers list (following_id pin) is guest-readable when following_visibility is true');
  const followersWithHiddenFollowing = await applyGuestReadPolicy('followers', followersRows, followingHiddenClient, ['following_id=eq.x1']);
  assert.equal(
    followersWithHiddenFollowing.length,
    1,
    'followers list stays visible even when following_visibility is false (Following/Followers are separate)'
  );
  const followersDefault = await applyGuestReadPolicy('followers', followersRows, followingNullClient, ['following_id=eq.x1']);
  assert.equal(followersDefault.length, 1, 'absent following_visibility defaults to public (matches app default)');

  // Mixed pin (both directions in one filter): each pinned profile is checked
  // against the rule of the column it was pinned on.
  const followersMixedClient = fakeClient([
    { id: 'x1', following_visibility: false },
    { id: 'y1', following_visibility: true },
  ]);
  const followersBothDirections = await applyGuestReadPolicy(
    'followers',
    [{ id: 'm1', follower_id: 'y1', following_id: 'x1' }],
    followersMixedClient,
    ['follower_id=eq.y1', 'following_id=eq.x1']
  );
  assert.equal(
    followersBothDirections.length,
    1,
    'mixed-direction read: follower_id subject public, following_id subject always public'
  );
  const followersBothDirectionsBlocked = await applyGuestReadPolicy(
    'followers',
    [{ id: 'm2', follower_id: 'x1', following_id: 'y1' }],
    followersMixedClient,
    ['follower_id=eq.x1', 'following_id=eq.y1']
  );
  assert.equal(
    followersBothDirectionsBlocked.length,
    0,
    'mixed-direction read is dropped when the follower_id subject hid its Following list'
  );

  // No filters pinned -> every involved profile must be public (never leaks).
  const mixedListClient = fakeClient([
    { id: 'x1', friends_visibility: 'public' },
    { id: 'y1', friends_visibility: 'friends' },
  ]);
  const friendsNoFilter = await applyGuestReadPolicy('friends', friendsRows, mixedListClient, undefined);
  assert.equal(friendsNoFilter.length, 0, 'no-pin friends read falls back to all involved profiles public');

  // --- profile lists for AUTHENTICATED viewers (do.md: the owner ALWAYS sees
  // --- their own Friends/Following/Followers; the API/Gateway distinguishes
  // --- OWNER / AUTHENTICATED OTHER / GUEST) ---

  // OWNER viewing their own profile: hidden/private lists stay visible.
  const ownerPrivateFriends = authClient({ profiles: [{ id: 'x1', friends_visibility: 'only_me' }] });
  const ownerFriends = await filterAuthenticatedProfileListRows('friends', friendsRows, ownerPrivateFriends, 'x1', friendsListFilters);
  assert.equal(ownerFriends.length, 2, 'OWNER sees their own Friends list even when friends_visibility is private');

  const ownerHiddenFollowing = authClient({ profiles: [{ id: 'x1', following_visibility: false }] });
  const ownerFollowing = await filterAuthenticatedProfileListRows('followers', followingRows, ownerHiddenFollowing, 'x1', ['follower_id=eq.x1']);
  assert.equal(ownerFollowing.length, 1, 'OWNER sees their own Following list even when following_visibility is false');
  const ownerFollowers = await filterAuthenticatedProfileListRows('followers', followersRows, ownerHiddenFollowing, 'x1', ['following_id=eq.x1']);
  assert.equal(ownerFollowers.length, 1, 'OWNER sees their own Followers list');

  // AUTHENTICATED OTHER user viewing someone else's profile: the owner's
  // per-list visibility applies.
  const otherPublicFriends = authClient({ profiles: [{ id: 'x1', friends_visibility: 'public' }] });
  const otherFriendsPublic = await filterAuthenticatedProfileListRows('friends', friendsRows, otherPublicFriends, 'other', friendsListFilters);
  assert.equal(otherFriendsPublic.length, 2, 'authenticated other sees Friends when the list is public');

  const otherPrivateFriends = authClient({ profiles: [{ id: 'x1', friends_visibility: 'only_me' }] });
  const otherFriendsPrivate = await filterAuthenticatedProfileListRows('friends', friendsRows, otherPrivateFriends, 'other', friendsListFilters);
  assert.equal(otherFriendsPrivate.length, 0, 'authenticated other sees no Friends rows when the list is private');

  // 'friends'-only visibility: granted to an accepted friend, denied otherwise.
  const friendsOnlyClient = authClient({
    profiles: [{ id: 'x1', friends_visibility: 'friends' }],
    friendships: [{ requester_id: 'other', receiver_id: 'x1', status: 'accepted' }],
  });
  const otherFriendsFriend = await filterAuthenticatedProfileListRows('friends', friendsRows, friendsOnlyClient, 'other', friendsListFilters);
  assert.equal(otherFriendsFriend.length, 2, 'an accepted friend sees the friends-only Friends list');

  const friendsOnlyNonFriendClient = authClient({ profiles: [{ id: 'x1', friends_visibility: 'friends' }] });
  const otherFriendsNonFriend = await filterAuthenticatedProfileListRows('friends', friendsRows, friendsOnlyNonFriendClient, 'other', friendsListFilters);
  assert.equal(otherFriendsNonFriend.length, 0, 'a non-friend sees no rows of a friends-only Friends list');

  const otherFollowingVisible = authClient({ profiles: [{ id: 'x1', following_visibility: true }] });
  const otherFollowing = await filterAuthenticatedProfileListRows('followers', followingRows, otherFollowingVisible, 'other', ['follower_id=eq.x1']);
  assert.equal(otherFollowing.length, 1, 'authenticated other sees Following when following_visibility is true');

  const otherFollowingHidden = authClient({ profiles: [{ id: 'x1', following_visibility: false }] });
  const otherFollowingBlocked = await filterAuthenticatedProfileListRows('followers', followingRows, otherFollowingHidden, 'other', ['follower_id=eq.x1']);
  assert.equal(otherFollowingBlocked.length, 0, 'authenticated other sees no Following rows when hidden');

  const otherFollowers = await filterAuthenticatedProfileListRows('followers', followersRows, otherFollowingHidden, 'other', ['following_id=eq.x1']);
  assert.equal(otherFollowers.length, 1, 'authenticated other always sees Followers even when following_visibility is false');

  // Self-involved reads keep working: the requester's OWN friendship/follow
  // edge is always visible even when the other profile restricts its list
  // (the SPA's friendship-status, follow-status and checkIfFollowing reads pin
  // the requester and must not be gated by the other profile's settings).
  const ownEdge = await filterAuthenticatedProfileListRows(
    'friends',
    [{ id: 'e1', requester_id: 'other', receiver_id: 'x1', status: 'accepted' }],
    otherPrivateFriends,
    'other',
    ['or=(and(requester_id.eq.other,receiver_id.eq.x1),and(requester_id.eq.x1,receiver_id.eq.other))']
  );
  assert.equal(ownEdge.length, 1, "the requester's own friendship edge is visible even if the other profile hides its list");

  const ownFollow = await filterAuthenticatedProfileListRows(
    'followers',
    [{ id: 'e2', follower_id: 'other', following_id: 'x1' }],
    otherFollowingHidden,
    'other',
    ['follower_id=eq.other', 'following_id=eq.x1']
  );
  assert.equal(ownFollow.length, 1, 'checkIfFollowing-style read (requester pinned) stays visible');

  // --- single-row gates ---
  assert.equal(
    await isGuestSingleRowVisible('posts', PUBLISHED_PUBLIC_POST, publicPostClient),
    true,
    'public post single-row is guest-visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('posts', { ...PUBLISHED_PUBLIC_POST, visibility: 'only_me' }, publicPostClient),
    false,
    'non-public post single-row is hidden'
  );
  assert.equal(
    await isGuestSingleRowVisible('comments', { id: 'c1', post_id: 'post-1' }, publicPostClient),
    true,
    'comment on public post single-row is visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('comments', { id: 'c1', post_id: 'post-1' }, privatePostClient),
    false,
    'comment on private post single-row is hidden'
  );
  assert.equal(
    await isGuestSingleRowVisible('hashtag_links', { id: 'hl1', source_id: 'post-1' }, publicPostClient),
    true,
    'hashtag link on public post single-row is visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('hashtag_links', { id: 'hl1', source_id: 'post-1' }, privatePostClient),
    false,
    'hashtag link on private post single-row is hidden'
  );
  assert.equal(
    await isGuestSingleRowVisible('groups', { id: 'g1', privacy: 'public' }, publicPostClient),
    true,
    'public group single-row is visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('stories', { id: 's1' }, publicPostClient),
    false,
    'stories single-row is not guest-visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('life_events', { id: 'le1', visibility: 'public' }, publicPostClient),
    true,
    'public life event single-row is visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('life_events', { id: 'le1', visibility: 'friends' }, publicPostClient),
    false,
    'friends life event single-row is hidden'
  );
  assert.equal(
    await isGuestSingleRowVisible('family_relationships', { id: 'fr1', visibility: 'public' }, publicPostClient),
    true,
    'public family relationship single-row is visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('other_names', { id: 'on3', visibility: 'private' }, publicPostClient),
    false,
    'private other name single-row is hidden'
  );
  assert.equal(
    await isGuestSingleRowVisible('profile_details', { id: 'pd1' }, publicPostClient),
    true,
    'profile_details single-row is visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('friends', { id: 'f1', requester_id: 'x1' }, friendsPublicClient),
    false,
    'friends single-row read is never guest-visible (lists are batch reads keyed to the viewed profile)'
  );
  assert.equal(
    await isGuestSingleRowVisible('followers', { id: 'fs1', following_id: 'x1' }, followingPublicClient),
    false,
    'followers single-row read is never guest-visible'
  );
  assert.equal(
    await isGuestSingleRowVisible('companies', { id: 'c1' }, publicPostClient),
    true,
    'companies single-row is visible'
  );
  assert.equal(
    stripGuestSingleRowRead('profiles', profile).email,
    null,
    'profiles single-row is redacted'
  );
  assert.equal(
    (stripGuestSingleRowRead('posts', PUBLISHED_PUBLIC_POST) as GuestReadableRow).visibility,
    'public',
    'non-profile single-row passes through unchanged'
  );

  console.log('guestAccessTest: all assertions passed ✓');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});