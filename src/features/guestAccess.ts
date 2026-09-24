// Guest (logged-out) read policy for the Gateway's generic GET routes (do.md:
// "Public access" round). The Gateway proxies reads with service-role clients
// (RLS bypassed), so these pure rules are the API boundary that give a guest
// ONLY published public content and never private fields/rows. The SPA's own
// client-side filters remain as defense-in-depth; enforcement happens here.
//
// Authenticated behavior is untouched: every rule below applies only when
// `req.user` is undefined.
import { SupabaseClient } from '@supabase/supabase-js';

export type GuestReadableRow = Record<string, unknown>;

// Domains public surfaces READ from while logged out (posts/profiles/groups/
// pages/hashtags plus the join tables those surfaces resolve client-side:
// likes, comments, post_tags, group_posts, group_members, page_posts).
// Profile pages additionally read the About/profile content domains —
// profile_details, other_names, life_events and family_relationships — which
// apply per-row visibility filtering below, plus the public reference tables
// companies/colleges/high_schools that the About UI resolves Work/Education
// joins against (RLS "viewable by everyone"; no per-row privacy concept).
// The profile list tables friends/followers are also guest-readable, but ONLY
// as far as the profile owner's own per-list visibility allows: a guest sees a
// friends row only when the profile being viewed has friends_visibility='public',
// and a Following-list row (the `followers` table read with the viewed profile
// as follower_id) only when the viewed profile's following_visibility is true
// (the app's single follow-graph visibility toggle). The Followers list itself
// (the same table read with the viewed profile as following_id) has no separate
// setting in the schema or UI and is ALWAYS public — do.md: "Guest → Can view
// Followers". The Following and Followers lists are treated independently, so
// hiding Following never hides Followers. See filterGuestProfileListRows below.
// Anything else — stories, story_views, message_requests, notifications,
// privacy_settings, hidden_content, saved_posts, group_follows, group_pins,
// vault/security tables, … — is denied for guests with 403 at the route
// boundary before any row processing.
export const GUEST_READ_DOMAINS: ReadonlySet<string> = new Set([
  'posts',
  'profiles',
  'groups',
  'pages',
  'hashtags',
  'page_posts',
  'group_posts',
  'group_members',
  'likes',
  'comments',
  'post_tags',
  'hashtag_links',
  'profile_details',
  'other_names',
  'life_events',
  'family_relationships',
  'companies',
  'colleges',
  'high_schools',
  'friends',
  'followers',
]);

// A profile-adjacent row (other_names / life_events / family_relationships) is
// public to a guest only when its explicit `visibility` column is exactly
// 'public'. All three tables default to 'friends' and constrain values to
// ('public','friends','private'), so strict equality is correct and mirrors the
// tables' own RLS ("WHEN visibility = 'public' THEN true").
export function isGuestRowPublicVisibility(row: GuestReadableRow | null | undefined): boolean {
  return !!row && typeof row === 'object' && row['visibility'] === 'public';
}

export function isGuestReadableDomain(domain: string): boolean {
  return GUEST_READ_DOMAINS.has(domain);
}

// A post (reels are posts with type='reel') is public to a guest only when
// visibility, audience and status are all unrestricted:
//  - visibility: 'public' (absent treated as public — matches the app's
//    isPostVisibleToViewer, which hides only visibility!=='public')
//  - audience_type: absent or 'public' (only_me / friends / friends_except /
//    specific / custom_list are never public)
//  - status: 'published' or absent (drafts and scheduled posts are author-only;
//    scheduled posts are additionally stripped by scheduledPostPrivacy)
export function isGuestPostVisible(post: GuestReadableRow | null | undefined): boolean {
  if (!post || typeof post !== 'object') return false;
  const visibility = post['visibility'];
  if (visibility && visibility !== 'public') return false;
  const audience = post['audience_type'];
  if (audience && audience !== 'public') return false;
  const status = post['status'];
  if (status && status !== 'published') return false;
  return true;
}

export function filterGuestPosts(rows: GuestReadableRow[]): GuestReadableRow[] {
  return rows.filter(isGuestPostVisible);
}

// A guest may read a post's COMMENTS only when the post is itself guest-visible
// AND the owner has comments enabled (posts.comments_enabled, default true).
// This is the post owner's comment-visibility setting (do.md "Guest users —
// comments are viewable but read-only"): when the owner disables comments, a
// guest must not see them at all. Likes/tags are NOT subject to this toggle —
// only the comments themselves are.
export function isGuestPostCommentsVisible(post: GuestReadableRow | null | undefined): boolean {
  if (!isGuestPostVisible(post)) return false;
  return (post as GuestReadableRow)['comments_enabled'] !== false;
}

// A group is viewable by a guest only when it is marked public. Closed groups
// require approval to join and private groups are invite-only — neither is
// guest-readable.
export function isGuestGroupVisible(group: GuestReadableRow | null | undefined): boolean {
  return !!group && typeof group === 'object' && group['privacy'] === 'public';
}

// --- profiles ---
// Fields gated by a *_visibility column are public to a guest only when that
// column is exactly 'public' (absent visibility defaults to public, mirroring
// the app's own viewer display forms). Fields that gate account/settings data
// and have no visibility column are never handed to a guest.
const PROFILE_VISIBILITY_PAIRS: ReadonlyArray<[field: string, visibilityCol: string]> = [
  ['about_you', 'about_you_visibility'],
  ['birth_date', 'birth_date_visibility'],
  ['birth_year', 'birth_year_visibility'],
  ['email', 'email_visibility'],
  ['phone_number', 'phone_visibility'],
  ['phone_country_code', 'phone_visibility'],
  ['gender', 'gender_visibility'],
  ['pronouns', 'pronouns_visibility'],
  ['college', 'college_visibility'],
  ['college_id', 'college_visibility'],
  ['company_id', 'company_visibility'],
  ['function', 'function_visibility'],
  ['high_school', 'high_school_visibility'],
  ['high_school_id', 'high_school_visibility'],
  ['relationship_status', 'relationship_visibility'],
  ['websites_social_links', 'websites_visibility'],
  ['name_pronunciation', 'name_pronunciation_visibility'],
];

// Always-private profile fields a logged-out visitor must never receive,
// regardless of any visibility column.
const PROFILE_ALWAYS_PRIVATE: ReadonlyArray<string> = [
  'vault_pin',
  'vault_recovery_code',
  'remember_browser',
  'preview_mode',
  'security_warnings',
  'check_keys_in_conversations',
  'show_read_indicator',
  'disable_auto_uploads',
];

export function stripPrivateProfileFields(row: GuestReadableRow): GuestReadableRow {
  const redacted = { ...row };
  for (const [field, visCol] of PROFILE_VISIBILITY_PAIRS) {
    if (redacted[field] == null) continue;
    const visibility = redacted[visCol];
    if (visibility != null && visibility !== 'public') {
      redacted[field] = null;
    }
  }
  for (const field of PROFILE_ALWAYS_PRIVATE) {
    if (field in redacted) redacted[field] = null;
  }
  return redacted;
}

// --- profile lists (friends/following/followers) ---
// A profile-list row may be read by a viewer only as far as the viewed
// profile's per-list visibility allows, and the rule is enforced at the API
// boundary for EVERY viewer type (do.md "profile owner must always see their
// own lists"):
//   OWNER (requesterId === the pinned profile) -> every row is returned; the
//     owner's own visibility settings NEVER restrict their own lists.
//   AUTHENTICATED OTHER USER -> the owner's per-list visibility applies:
//     friends    -> only when profiles.friends_visibility is 'public', or
//                   'friends' AND the requester is an accepted friend of the
//                   profile ('private'/'only_me' -> hidden)
//     following  -> follower_id==X pins (who X follows) require
//                   profiles[X].following_visibility !== false
//     followers  -> following_id==X pins (who follows X) are ALWAYS public
//                   (the app has no separate followers visibility column)
//   GUEST -> the same per-list visibility applies, minus the friend check
//     (guests are never 'friends'; do.md: Guest -> Friends/Following only when
//     Public, Followers always).
// Rows the requester is a PARTY to — when they also pinned themselves in the
// query — are their own edges (friendship status, checkIfFollowing, own
// lists) and are always visible; gating them would break those reads.
// The generic read path first applies the client's query filters server-side
// (`or=(requester_id.eq.X,receiver_id.eq.X)` for friends,
// `follower_id=eq.X` for following, `following_id=eq.X` for followers), so
// every returned row is guaranteed to involve the pinned profile(s). We
// re-parse those same filters to recover the pinned profiles ("subjects")
// grouped by the column they were pinned on, and gate each row against the
// rule for the column(s) it belongs to. A read pinning no subject falls back
// to per-column rules over every involved profile (never leaks a restricted
// list).

// Resolves the pinned profiles' rows (id + friends_visibility +
// following_visibility) for the profile-list gate. The gate MUST NOT read them
// through the list host's own client: in production the `friends`/`followers`
// tables and the `profiles` table are served by DIFFERENT Supabase projects, so
// `listClient.from('profiles')` comes back empty and `allowedForList` would
// drop every non-owner row — public lists included (do.md regression: only the
// self-pinned owner bypass was surviving). The GET route supplies a reader
// backed by the profiles-domain projects; offline tests may omit it, in which
// case the legacy same-host lookup is used for the single-host mocks.
export type ProfileRowsReader = (ids: string[]) => Promise<GuestReadableRow[]>;

// Same pattern for posts: in production the comments (and likes/post_tags)
// tables live on their OWN Supabase project(s), so a guest comment read cannot
// resolve the parent post rows through the comments-host client. The GET route
// supplies a reader fanning out over the posts-domain projects (see
// resolveProfiles); offline tests may omit it and fall back to the same-host
// lookup used by the single-host mocks.
export type PostsRowsReader = (ids: string[]) => Promise<GuestReadableRow[]>;

// Split a PostgREST filter expression into its top-level comma-separated terms
// (respects nested parens, e.g. or=(and(a),and(b))).
function splitFilterTerms(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Walk a filter expression and collect every id pinned by `eq` on one of the
// given columns, grouped by column (so the caller knows WHICH list each subject
// was pinned through). Accepts top-level `col=eq.val` filters and `or=(...)` /
// `and=(...)` groups whose terms use PostgREST dot notation (`col.eq.val`).
function collectEqPins(expr: string, cols: ReadonlySet<string>, out: Map<string, Set<string>>): void {
  const e = expr.trim();
  if (e.startsWith('or=') || e.startsWith('and=')) {
    for (const term of splitFilterTerms(e.slice(3).replace(/^\(|\)$/g, ''))) {
      collectEqPins(term, cols, out);
    }
    return;
  }
  const unwrapped = e.replace(/^\(|\)$/g, '');
  const group = unwrapped.match(/^(and|or)\(/);
  if (group) {
    for (const term of splitFilterTerms(unwrapped.slice(unwrapped.indexOf('(') + 1, -1))) {
      collectEqPins(term, cols, out);
    }
    return;
  }
  const m = unwrapped.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:=|\.)eq\.(.+)$/);
  if (!m) return;
  if (!cols.has(m[1])) return;
  const val = m[2].replace(/^\(|\)$/g, '').replace(/^['"]|['"]$/g, '');
  if (val && val !== 'null' && val !== 'true' && val !== 'false') {
    if (!out.has(m[1])) out.set(m[1], new Set());
    out.get(m[1])!.add(val);
  }
}

interface ProfileListSpec {
  // The columns a list-domain query pins a profile by. `friends` rows belong
  // to both users (each row is part of either profile's friends list);
  // `followers` rows belong to the follower_id profile (its Following list)
  // and to the following_id profile (its Followers list).
  subjectCols: ReadonlyArray<string>;
}

const PROFILE_LIST_SPECS: Record<string, ProfileListSpec> = {
  friends: { subjectCols: ['requester_id', 'receiver_id'] },
  followers: { subjectCols: ['follower_id', 'following_id'] },
};

// True when an accepted friendship edge exists between `a` and `b` (used by the
// friends domain's 'friends'-only visibility for an authenticated viewer).
export async function hasAcceptedFriendship(client: GuestClient, a: string, b: string): Promise<boolean> {
  const { data } = await client
    .from('friends')
    .select('id')
    .or(`and(requester_id.eq.${a},receiver_id.eq.${b}),and(requester_id.eq.${b},receiver_id.eq.${a})`)
    .eq('status', 'accepted')
    .maybeSingle();
  return !!data;
}

// Viewer-aware gate for profile-list reads (friends / following / followers).
// `requesterId` is the authenticated viewer, or undefined for a guest. Owns:
//   - every row the requester is a party to AND pinned themselves in the query
//     (their own edges / own lists) is always returned — the profile owner must
//     never be restricted by their own visibility settings (do.md);
//   - other rows are returned only when every pinned subject belongs to a list
//     this viewer may read (per-column rule above).
export async function filterProfileListRowsForViewer(
  domain: 'friends' | 'followers',
  rows: GuestReadableRow[],
  client: GuestClient,
  requesterId: string | undefined,
  filters?: string | string[] | undefined,
  resolveProfiles?: ProfileRowsReader
): Promise<GuestReadableRow[]> {
  const spec = PROFILE_LIST_SPECS[domain];
  const subjectsByCol = new Map<string, Set<string>>();
  const filterList = Array.isArray(filters) ? filters : filters ? [filters] : [];
  for (const f of filterList) collectEqPins(f, new Set(spec.subjectCols), subjectsByCol);
  const pinnedTotal = [...subjectsByCol.values()].reduce((n, s) => n + s.size, 0);
  if (pinnedTotal === 0) {
    // No subject pinned by the query — treat every profile involved in the
    // rows as a subject (grouped by its column, so the per-list rule still
    // applies row by row). Over-restrictive, but it can never leak a row whose
    // owner kept their list restricted.
    for (const r of rows) {
      for (const col of spec.subjectCols) {
        const id = ROW_PROP(r, col);
        if (!id) continue;
        if (!subjectsByCol.has(col)) subjectsByCol.set(col, new Set());
        subjectsByCol.get(col)!.add(id);
      }
    }
  }
  const ids = new Set<string>();
  for (const set of subjectsByCol.values()) for (const id of set) ids.add(id);
  if (ids.size === 0) return rows;
  // The subjects' visibility rows come from the profiles-domain reader when
  // supplied (production). The offline fallback resolves them through the list
  // host client, which is a valid approximation only in the single-host mocks.
  const idsArr = [...ids];
  const profileRows = resolveProfiles
    ? await resolveProfiles(idsArr)
    : ((await client.from('profiles').select('*').in('id', idsArr)).data as GuestReadableRow[] | null);
  const byId = new Map<string, GuestReadableRow>();
  for (const p of (profileRows as GuestReadableRow[]) || []) byId.set(String(p['id']), p);

  // True when the requester pinned themselves as a subject of this read
  // (own-list / friendship-status / checkIfFollowing reads).
  const selfPinned = !!requesterId && [...subjectsByCol.values()].some((s) => s.has(requesterId));
  const involvesRequester = (row: GuestReadableRow): boolean =>
    !!requesterId && spec.subjectCols.some((col) => ROW_PROP(row, col) === requesterId);

  // Cache for the friends domain's 'friends'-only visibility: is the requester
  // an accepted friend of the subject profile (authenticated viewers only)?
  const friendOf = new Map<string, boolean>();
  const isFriendOf = async (profileId: string): Promise<boolean> => {
    if (!requesterId) return false;
    let v = friendOf.get(profileId);
    if (v === undefined) {
      v = await hasAcceptedFriendship(client, requesterId, profileId);
      friendOf.set(profileId, v);
    }
    return v;
  };

  // Whether the subject `profileId` (pinned on `col`) may show this list to the
  // requester. The requester themselves always counts as allowed (the self-row
  // bypass covers the common case; this is the safety net).
  const allowedForList = async (col: string, profileId: string): Promise<boolean> => {
    if (requesterId && profileId === requesterId) return true;
    const profile = byId.get(profileId);
    if (!profile) return false;
    if (domain === 'followers') {
      // Following list (follower_id pin) follows the follow-graph toggle; the
      // Followers list (following_id pin) is always public.
      return col === 'following_id' ? true : profile['following_visibility'] !== false;
    }
    // friends domain: public, or 'friends'-only for an accepted friend.
    const vis = profile['friends_visibility'];
    if (vis == null || vis === 'public') return true;
    if (vis === 'friends') return await isFriendOf(profileId);
    return false;
  };

  const out: GuestReadableRow[] = [];
  for (const row of rows) {
    if (selfPinned && involvesRequester(row)) {
      out.push(row);
      continue;
    }
    let keep = true;
    for (const [col, colIds] of subjectsByCol) {
      const val = ROW_PROP(row, col);
      if (!val || !colIds.has(val)) continue;
      if (!(await allowedForList(col, val))) {
        keep = false;
        break;
      }
    }
    if (keep) out.push(row);
  }
  return out;
}

// Guest profile-list reads: a guest is never a pinned party and has no
// friendships, so the 'friends'-only check resolves to false.
export async function filterGuestProfileListRows(
  domain: 'friends' | 'followers',
  rows: GuestReadableRow[],
  client: GuestClient,
  filters?: string | string[] | undefined,
  resolveProfiles?: ProfileRowsReader
): Promise<GuestReadableRow[]> {
  return filterProfileListRowsForViewer(domain, rows, client, undefined, filters, resolveProfiles);
}

// Authenticated profile-list reads: OWNER rows (requester is a party and
// pinned) are always allowed; other users' lists follow the owner's per-list
// visibility (do.md: the API/Gateway distinguishes OWNER / AUTHENTICATED
// OTHER / GUEST, and the owner always sees their own lists).
export async function filterAuthenticatedProfileListRows(
  domain: 'friends' | 'followers',
  rows: GuestReadableRow[],
  client: GuestClient,
  requesterId: string,
  filters?: string | string[] | undefined,
  resolveProfiles?: ProfileRowsReader
): Promise<GuestReadableRow[]> {
  return filterProfileListRowsForViewer(domain, rows, client, requesterId, filters, resolveProfiles);
}

// --- parent-scoped rows (likes/comments/post_tags on posts, group_posts/
// group_members in groups) ---
// A guest may only read a child row when its parent is itself guest-visible —
// so a private post's comments/likes/tags and a closed/private group's posts
// or member list never leak through the generic read.

type GuestClient = Pick<SupabaseClient, 'from'>;

const ROW_PROP = (row: GuestReadableRow, col: string): string =>
  typeof row[col] === 'string' ? (row[col] as string) : '';

async function loadVisiblePostIds(
  client: GuestClient,
  postIds: string[],
  predicate: (post: GuestReadableRow) => boolean = isGuestPostVisible,
  resolvePosts?: PostsRowsReader
): Promise<Set<string>> {
  const ids = [...new Set(postIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  let data: GuestReadableRow[] | null | undefined;
  if (resolvePosts) {
    try {
      data = await resolvePosts(ids);
    } catch {
      data = null;
    }
  } else {
    const { data: sameHostRows } = await client.from('posts').select('*').in('id', ids);
    data = sameHostRows as GuestReadableRow[] | null | undefined;
  }
  const visible = new Set<string>();
  for (const row of (data as GuestReadableRow[]) || []) {
    if (predicate(row)) visible.add(String(row['id']));
  }
  return visible;
}

async function loadVisibleGroupIds(
  client: GuestClient,
  groupIds: string[]
): Promise<Set<string>> {
  const ids = [...new Set(groupIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const { data } = await client.from('groups').select('*').in('id', ids);
  const visible = new Set<string>();
  for (const row of (data as GuestReadableRow[]) || []) {
    if (isGuestGroupVisible(row)) visible.add(String(row['id']));
  }
  return visible;
}

export async function filterGuestPostScopedRows(
  rows: GuestReadableRow[],
  client: GuestClient,
  postIdCol = 'post_id'
): Promise<GuestReadableRow[]> {
  const visible = await loadVisiblePostIds(client, rows.map((r) => ROW_PROP(r, postIdCol)));
  return rows.filter((r) => visible.has(ROW_PROP(r, postIdCol)));
}

// Comments additionally respect the post owner's comments_enabled setting: a
// guest may read a comment only when its post is guest-visible AND comments
// are enabled on it (do.md comments round). Disabled comments on a public post
// become invisible to guests, indistinguishable from a post with no comments.
export async function filterGuestCommentScopedRows(
  rows: GuestReadableRow[],
  client: GuestClient,
  postIdCol = 'post_id',
  resolvePosts?: PostsRowsReader
): Promise<GuestReadableRow[]> {
  const visible = await loadVisiblePostIds(
    client,
    rows.map((r) => ROW_PROP(r, postIdCol)),
    isGuestPostCommentsVisible,
    resolvePosts
  );
  return rows.filter((r) => visible.has(ROW_PROP(r, postIdCol)));
}

// Comment rows embed the commenter's `reactions:comment_reactions` relation,
// whose rows carry the REACTOR's identity. A guest may read a comment but must
// never see WHO reacted to it, so each embedded reaction is stripped of
// user_id (emoji/created_at stay — the summary counter the UI already renders
// needs only the emoji). The commenter's own profile embed is part of the
// comment and stays.
export function stripGuestCommentRow(row: GuestReadableRow): GuestReadableRow {
  const out: GuestReadableRow = { ...row };
  const reactions = out['reactions'];
  if (Array.isArray(reactions)) {
    out['reactions'] = reactions.map((r) => {
      if (!r || typeof r !== 'object') return r;
      const copy: Record<string, unknown> = { ...(r as Record<string, unknown>) };
      delete copy['user_id'];
      return copy;
    });
  }
  return out;
}

export async function filterGuestGroupScopedRows(
  rows: GuestReadableRow[],
  client: GuestClient
): Promise<GuestReadableRow[]> {
  const visible = await loadVisibleGroupIds(client, rows.map((r) => ROW_PROP(r, 'group_id')));
  return rows.filter((r) => visible.has(ROW_PROP(r, 'group_id')));
}

// Full per-domain guest filtering for a list read. `domain` is guaranteed to
// be in GUEST_READ_DOMAINS by the caller. `filters` carries the client's query
// filters (needed only by the profile-list domains to recover the viewed owner).
export async function applyGuestReadPolicy(
  domain: string,
  rows: GuestReadableRow[],
  client: GuestClient,
  filters?: string | string[] | undefined,
  resolveProfiles?: ProfileRowsReader,
  resolvePosts?: PostsRowsReader
): Promise<GuestReadableRow[]> {
  switch (domain) {
    case 'posts':
      return filterGuestPosts(rows);
    case 'profiles':
      return rows.map(stripPrivateProfileFields);
    case 'groups':
      return rows.filter(isGuestGroupVisible);
    case 'pages':
    case 'hashtags':
    case 'page_posts':
      // Pages, hashtags and page_posts are public-by-design entities.
      return rows;
    case 'profile_details':
    case 'companies':
    case 'colleges':
    case 'high_schools':
      // Public-by-design records with no per-row privacy: profile_details rows
      // carry no visibility column (RLS "viewable by everyone"; About/Places),
      // and companies/colleges/high_schools are public reference dictionaries.
      return rows;
    case 'other_names':
    case 'life_events':
    case 'family_relationships':
      // Explicit per-row visibility: only 'public' rows are guest-readable.
      return rows.filter(isGuestRowPublicVisibility);
    case 'friends':
    case 'followers':
      // Per-list owner visibility, keyed by the column the viewed profile was
      // pinned on: friends need friends_visibility == 'public'; the Following
      // list (follower_id pin) needs following_visibility true; the Followers
      // list (following_id pin) is always public.
      return filterGuestProfileListRows(domain, rows, client, filters, resolveProfiles);
    case 'group_posts':
    case 'group_members':
      return filterGuestGroupScopedRows(rows, client);
    case 'likes':
    case 'post_tags':
      return filterGuestPostScopedRows(rows, client);
    case 'comments':
      // Comments respect the owner's comments_enabled setting, and reactor
      // identities in the embedded reactions are stripped for guests. Parent
      // post rows are resolved across the posts-domain projects (the comments
      // host cannot serve the posts table in production).
      return (await filterGuestCommentScopedRows(rows, client, 'post_id', resolvePosts)).map(stripGuestCommentRow);
    case 'hashtag_links':
      // hashtag_links.source_id is the linked post id (source_type='post').
      return filterGuestPostScopedRows(rows, client, 'source_id');
    default:
      return [];
  }
}

// Single-row read gate: true when the resolved row may be handed to a guest.
export async function isGuestSingleRowVisible(
  domain: string,
  row: GuestReadableRow,
  client: GuestClient,
  resolvePosts?: PostsRowsReader
): Promise<boolean> {
  switch (domain) {
    case 'posts':
      return isGuestPostVisible(row);
    case 'profiles':
      return true; // the row is redacted by stripGuestSingleRowRead before sending
    case 'groups':
      return isGuestGroupVisible(row);
    case 'pages':
    case 'hashtags':
    case 'page_posts':
      return true;
    case 'profile_details':
    case 'companies':
    case 'colleges':
    case 'high_schools':
      return true;
    case 'other_names':
    case 'life_events':
    case 'family_relationships':
      return isGuestRowPublicVisibility(row);
    case 'friends':
    case 'followers':
      // List rows are read via list queries keyed to the viewed profile; a
      // single-row id read has no subject to gate against, so it is never
      // served to a guest.
      return false;
    case 'group_posts':
    case 'group_members': {
      const visible = await loadVisibleGroupIds(client, [ROW_PROP(row, 'group_id')]);
      return visible.has(ROW_PROP(row, 'group_id'));
    }
    case 'likes':
    case 'post_tags': {
      const visible = await loadVisiblePostIds(client, [ROW_PROP(row, 'post_id')]);
      return visible.has(ROW_PROP(row, 'post_id'));
    }
    case 'comments': {
      // Single comment reads obey the same owner comments_enabled gate as the
      // list read (do.md comments round); parent posts resolve across the
      // posts-domain projects in production.
      const visible = await loadVisiblePostIds(client, [ROW_PROP(row, 'post_id')], isGuestPostCommentsVisible, resolvePosts);
      return visible.has(ROW_PROP(row, 'post_id'));
    }
    case 'hashtag_links': {
      const visible = await loadVisiblePostIds(client, [ROW_PROP(row, 'source_id')]);
      return visible.has(ROW_PROP(row, 'source_id'));
    }
    default:
      return false;
  }
}

// Applies the profile field redaction to a single resolved row (guests keep
// the public fields of any profile, including private profiles, but never the
// visibility-gated or account-private fields).
export function stripGuestSingleRowRead(domain: string, row: GuestReadableRow): GuestReadableRow {
  if (domain === 'profiles') return stripPrivateProfileFields(row);
  if (domain === 'comments') return stripGuestCommentRow(row);
  return row;
}