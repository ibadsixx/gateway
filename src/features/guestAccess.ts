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
// friends row only when the profile being viewed has
// friends_visibility='public', and a following/followers row only when the
// viewed profile's following_visibility is true (the app's single follow-graph
// visibility toggle — there is no separate followers setting in the schema or
// UI). See filterGuestProfileListRows below.
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
// A guest may read a list row for the profile whose list they are viewing ONLY
// when that profile owner made the list public:
//   friends    -> profiles.friends_visibility === 'public'
//   followers  -> profiles.following_visibility !== false
//                 (the app has no separate followers visibility column/setting;
//                  following_visibility is its single follow-graph toggle with
//                  a default of true = public)
// The generic read path first applies the client's query filters server-side
// (`or=(requester_id.eq.X,receiver_id.eq.X)` for friends,
// `follower_id=eq.X` for following, `following_id=eq.X` for followers), so
// every returned row is guaranteed to involve the viewed profile. We re-parse
// those same filters to recover the viewed profile ("subject"), check that
// profile's visibility, and drop the whole batch when it is not public — the
// gateway must never hand restricted list data to a guest.

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
// given columns. Accepts top-level `col=eq.val` filters and `or=(...)` /
// `and=(...)` groups whose terms use PostgREST dot notation (`col.eq.val`).
function collectEqPins(expr: string, cols: ReadonlySet<string>, out: Set<string>): void {
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
  if (val && val !== 'null' && val !== 'true' && val !== 'false') out.add(val);
}

interface ProfileListSpec {
  subjectCols: ReadonlyArray<string>;
  // A subject profile permits guest reads of this list when allow(profile) is
  // true. Absent visibility columns default to public (matches the app).
  allow: (profile: GuestReadableRow) => boolean;
}

const PROFILE_LIST_SPECS: Record<string, ProfileListSpec> = {
  friends: {
    subjectCols: ['requester_id', 'receiver_id'],
    allow: (p) => p['friends_visibility'] == null || p['friends_visibility'] === 'public',
  },
  followers: {
    subjectCols: ['follower_id', 'following_id'],
    allow: (p) => p['following_visibility'] !== false,
  },
};

export async function filterGuestProfileListRows(
  domain: 'friends' | 'followers',
  rows: GuestReadableRow[],
  client: GuestClient,
  filters?: string | string[] | undefined
): Promise<GuestReadableRow[]> {
  const spec = PROFILE_LIST_SPECS[domain];
  const subjects = new Set<string>();
  const filterList = Array.isArray(filters) ? filters : filters ? [filters] : [];
  for (const f of filterList) collectEqPins(f, new Set(spec.subjectCols), subjects);
  if (subjects.size === 0) {
    // No subject pinned by the query — treat every profile involved in the
    // rows as a subject. Over-restrictive, but it can never leak a row whose
    // owner kept their list restricted.
    for (const r of rows) {
      for (const col of spec.subjectCols) {
        const id = ROW_PROP(r, col);
        if (id) subjects.add(id);
      }
    }
  }
  if (subjects.size === 0) return rows;
  const ids = [...subjects];
  const { data } = await client.from('profiles').select('*').in('id', ids);
  const byId = new Map<string, GuestReadableRow>();
  for (const p of (data as GuestReadableRow[]) || []) byId.set(String(p['id']), p);
  for (const id of ids) {
    const profile = byId.get(id);
    if (!profile || !spec.allow(profile)) return [];
  }
  return rows;
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
  postIds: string[]
): Promise<Set<string>> {
  const ids = [...new Set(postIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const { data } = await client.from('posts').select('*').in('id', ids);
  const visible = new Set<string>();
  for (const row of (data as GuestReadableRow[]) || []) {
    if (isGuestPostVisible(row)) visible.add(String(row['id']));
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
  filters?: string | string[] | undefined
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
      // Per-list owner visibility: the viewed profile must have made the list
      // public (friends_visibility == 'public'; following_visibility true).
      return filterGuestProfileListRows(domain, rows, client, filters);
    case 'group_posts':
    case 'group_members':
      return filterGuestGroupScopedRows(rows, client);
    case 'likes':
    case 'comments':
    case 'post_tags':
      return filterGuestPostScopedRows(rows, client);
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
  client: GuestClient
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
    case 'comments':
    case 'post_tags': {
      const visible = await loadVisiblePostIds(client, [ROW_PROP(row, 'post_id')]);
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
  return domain === 'profiles' ? stripPrivateProfileFields(row) : row;
}