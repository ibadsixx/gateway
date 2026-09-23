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
// Anything else — stories, story_views, message_requests, friends, followers,
// notifications, privacy_settings, hidden_content, saved_posts, group_follows,
// group_pins, vault/security tables, … — is denied for guests with 403 at the
// route boundary before any row processing.
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
// be in GUEST_READ_DOMAINS by the caller.
export async function applyGuestReadPolicy(
  domain: string,
  rows: GuestReadableRow[],
  client: GuestClient
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