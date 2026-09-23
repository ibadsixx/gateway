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

async function main(): Promise<void> {
  // --- domain allowlist ---
  for (const domain of ['posts', 'profiles', 'groups', 'pages', 'hashtags', 'page_posts', 'group_posts', 'group_members', 'likes', 'comments', 'post_tags', 'hashtag_links']) {
    assert.equal(isGuestReadableDomain(domain), true, `guest may read ${domain}`);
  }
  assert.equal(GUEST_READ_DOMAINS.size, 12, 'exactly the public-surface domains are guest-readable');
  for (const denied of ['stories', 'story_views', 'story_reactions', 'story_highlights', 'message_requests', 'messages', 'conversations', 'friends', 'followers', 'notifications', 'privacy_settings', 'hidden_content', 'saved_posts', 'group_follows', 'group_pins', 'post_shares', 'blocks']) {
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