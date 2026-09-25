// Gateway authorization and paginated reads for post/comment reaction users.
//
// Reaction rows carry reactor identities, so the generic service-role reads and
// the dedicated reaction-users endpoint must enforce the owner's visibility
// setting before returning any row. Counts are deliberately read separately:
// seeing "25 reactions" never implies seeing who those 25 people are.
//
// The gateway's projects are sharded by domain. The helpers below therefore
// fan out across every readable project for a domain and never assume that
// posts, comments, profiles, friendships, or privacy settings share a client
// with the reaction table.

import { isGuestPostVisible } from './guestAccess';

export type ReactionContentType = 'post' | 'comment';
export type ReactionVisibility = 'public' | 'friends' | 'friends_of_friends' | 'only_me';
export type ReactionRow = Record<string, unknown>;

export interface ReactionClient {
  from(table: string): any;
}

export interface ReactionProject {
  client: ReactionClient;
}

export interface ReactionTypeCounts {
  reaction_count: number;
  reaction_types: Record<string, number>;
}

export interface ReactionUserRow {
  id: string;
  user_id: string;
  reaction_type: string;
  created_at: string | null;
}

export interface ReactionUsersPage extends ReactionTypeCounts {
  users: ReactionUserRow[];
  filtered_reaction_count: number;
  has_more: boolean;
  next_offset: number | null;
}

export interface PublicReactionUser extends ReactionUserRow {
  username: string;
  display_name: string;
  profile_pic: string | null;
}

export interface CommentReactionSummary extends ReactionTypeCounts {
  viewer_reactions: ReactionUserRow[];
}

export interface ReactionContentResolution {
  status: 'allowed' | 'not_found' | 'forbidden';
  post: ReactionRow | null;
  comment: ReactionRow | null;
  ownerId: string | null;
  postId: string | null;
  contentVisible: boolean;
  setting: ReactionVisibility;
  canViewUsers: boolean;
}

export interface ReactionContentDeps {
  posts: ReactionProject[];
  comments: ReactionProject[];
  privacySettings: ReactionProject[];
  friends: ReactionProject[];
}

export interface ReactionUsersDeps extends ReactionContentDeps {
  reactionProjects: ReactionProject[];
  profiles?: ReactionProject[];
}

const POST_TABLE = 'reactions';
const COMMENT_TABLE = 'comment_reactions';
const REACTION_TYPE_COLUMN: Record<ReactionContentType, 'type' | 'emoji'> = {
  post: 'type',
  comment: 'emoji',
};
const CONTENT_ID_COLUMN: Record<ReactionContentType, 'post_id' | 'comment_id'> = {
  post: 'post_id',
  comment: 'comment_id',
};

const POST_TYPE_ALIASES: Record<string, string> = {
  like: 'ok',
  love: 'red_heart',
  haha: 'laughing',
  wow: 'astonished',
  sad: 'cry',
  angry: 'rage',
  ok: 'ok',
  red_heart: 'red_heart',
  laughing: 'laughing',
  astonished: 'astonished',
  cry: 'cry',
  rage: 'rage',
  hug_face: 'hug_face',
};

// Older comment rows may still contain the emoji values from the first
// comment_reactions migration. New rows use the same canonical keys as posts.
const COMMENT_TYPE_ALIASES: Record<string, string> = {
  '❤️': 'red_heart',
  '❤': 'red_heart',
  '♥': 'red_heart',
  '👍': 'ok',
  '😆': 'laughing',
  '😄': 'laughing',
  '😂': 'laughing',
  '😮': 'astonished',
  '😲': 'astonished',
  '😢': 'cry',
  '😡': 'rage',
  ok: 'ok',
  red_heart: 'red_heart',
  laughing: 'laughing',
  astonished: 'astonished',
  cry: 'cry',
  rage: 'rage',
  hug_face: 'hug_face',
};

const REACTION_VISIBILITY_SETTING_NAMES = [
  'reactions_visibility',
  'reaction_users_visibility',
  'reaction_visibility',
  'who_can_see_reactors',
] as const;

export const DEFAULT_REACTION_VISIBILITY: ReactionVisibility = 'public';

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rowValue(row: ReactionRow | null | undefined, key: string): string | null {
  return row ? stringValue(row[key]) : null;
}

function rowsFromResult(result: any): ReactionRow[] {
  if (!result || result.error) return [];
  return Array.isArray(result.data) ? result.data.filter((row: unknown): row is ReactionRow => !!row && typeof row === 'object') : [];
}

async function queryRows(
  client: ReactionClient,
  table: string,
  build: (query: any) => any
): Promise<ReactionRow[]> {
  try {
    return rowsFromResult(await build(client.from(table)));
  } catch {
    // A domain can be sharded over projects that do not all contain the table.
    return [];
  }
}

async function queryOne(
  projects: ReactionProject[],
  table: string,
  id: string
): Promise<ReactionRow | null> {
  for (const project of projects) {
    try {
      const result = await project.client.from(table).select('*').eq('id', id).maybeSingle();
      if (!result?.error && result?.data && typeof result.data === 'object') {
        return result.data as ReactionRow;
      }
    } catch {
      // Try the next project. Some offline/fallback projects do not serve table.
    }
    // A small number of test/fallback clients do not implement maybeSingle.
    // The list form is equivalent and keeps the reader compatible with them.
    try {
      const result = await project.client.from(table).select('*').eq('id', id).limit(1);
      const row = Array.isArray(result?.data) ? result.data[0] : result?.data;
      if (!result?.error && row && typeof row === 'object') return row as ReactionRow;
    } catch {
      // Continue to the next project.
    }
  }
  return null;
}

export async function resolvePost(
  projects: ReactionProject[],
  postId: string
): Promise<ReactionRow | null> {
  return queryOne(projects, 'posts', postId);
}

export async function resolveComment(
  projects: ReactionProject[],
  commentId: string
): Promise<ReactionRow | null> {
  return queryOne(projects, 'comments', commentId);
}

export async function resolvePosts(
  projects: ReactionProject[],
  postIds: string[]
): Promise<Map<string, ReactionRow>> {
  const ids = [...new Set(postIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const byId = new Map<string, ReactionRow>();
  if (ids.length === 0) return byId;

  await Promise.all(
    projects.map(async (project) => {
      const rows = await queryRows(project.client, 'posts', (query) => query.select('*').in('id', ids));
      for (const row of rows) {
        const id = rowValue(row, 'id');
        if (id) byId.set(id, row);
      }
    })
  );
  return byId;
}

export async function resolveComments(
  projects: ReactionProject[],
  commentIds: string[]
): Promise<Map<string, ReactionRow>> {
  const ids = [...new Set(commentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const byId = new Map<string, ReactionRow>();
  if (ids.length === 0) return byId;

  await Promise.all(
    projects.map(async (project) => {
      const rows = await queryRows(project.client, 'comments', (query) => query.select('*').in('id', ids));
      for (const row of rows) {
        const id = rowValue(row, 'id');
        if (id) byId.set(id, row);
      }
    })
  );
  return byId;
}

export function canonicalReactionType(value: unknown, kind: ReactionContentType): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const aliases = kind === 'post' ? POST_TYPE_ALIASES : COMMENT_TYPE_ALIASES;
  return aliases[raw] || raw;
}

function rawValuesForType(type: string | undefined, kind: ReactionContentType): string[] | null {
  if (!type) return null;
  const canonical = canonicalReactionType(type, kind);
  if (!canonical) return [];

  if (kind === 'post') {
    return [canonical, ...Object.keys(POST_TYPE_ALIASES).filter((key) => POST_TYPE_ALIASES[key] === canonical)];
  }
  return [canonical, ...Object.keys(COMMENT_TYPE_ALIASES).filter((key) => COMMENT_TYPE_ALIASES[key] === canonical)];
}

function reactionTable(kind: ReactionContentType): string {
  return kind === 'post' ? POST_TABLE : COMMENT_TABLE;
}

function compareReactionRows(a: ReactionRow, b: ReactionRow): number {
  const aCreated = stringValue(a.created_at) || '';
  const bCreated = stringValue(b.created_at) || '';
  if (aCreated !== bCreated) return aCreated < bCreated ? 1 : -1;
  const aId = stringValue(a.id) || `${stringValue(a.user_id) || ''}:${stringValue(a.type) || stringValue(a.emoji) || ''}`;
  const bId = stringValue(b.id) || `${stringValue(b.user_id) || ''}:${stringValue(b.type) || stringValue(b.emoji) || ''}`;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function countRows(rows: ReactionRow[], kind: ReactionContentType): ReactionTypeCounts {
  const reactionTypes: Record<string, number> = {};
  let reactionCount = 0;
  for (const row of rows) {
    const raw = row[REACTION_TYPE_COLUMN[kind]];
    const type = canonicalReactionType(raw, kind);
    if (!type) continue;
    reactionTypes[type] = (reactionTypes[type] || 0) + 1;
    reactionCount += 1;
  }
  return { reaction_count: reactionCount, reaction_types: reactionTypes };
}

async function readAggregateRows(
  projects: ReactionProject[],
  kind: ReactionContentType,
  contentId: string,
  type?: string
): Promise<ReactionRow[]> {
  const typeValues = rawValuesForType(type, kind);
  if (typeValues?.length === 0) return [];
  const table = reactionTable(kind);
  const typeColumn = REACTION_TYPE_COLUMN[kind];
  const contentColumn = CONTENT_ID_COLUMN[kind];

  const chunks = await Promise.all(
    projects.map(async (project) =>
      queryRows(project.client, table, (query) => {
        let next = query.select(typeColumn).eq(contentColumn, contentId);
        if (typeValues) next = next.in(typeColumn, typeValues);
        return next;
      })
    )
  );
  return chunks.flat();
}

export async function getReactionTypeCounts(
  projects: ReactionProject[],
  kind: ReactionContentType,
  contentId: string,
  type?: string
): Promise<ReactionTypeCounts> {
  return countRows(await readAggregateRows(projects, kind, contentId, type), kind);
}

export async function getReactionUsersPage(
  projects: ReactionProject[],
  kind: ReactionContentType,
  contentId: string,
  options: { limit?: number; offset?: number; type?: string } = {}
): Promise<ReactionUsersPage> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const typeValues = rawValuesForType(options.type, kind);
  const table = reactionTable(kind);
  const typeColumn = REACTION_TYPE_COLUMN[kind];
  const contentColumn = CONTENT_ID_COLUMN[kind];

  const [aggregateRows, pageChunks] = await Promise.all([
    readAggregateRows(projects, kind, contentId),
    typeValues?.length === 0
      ? Promise.resolve([] as ReactionRow[][])
      : Promise.all(
          projects.map(async (project) =>
            queryRows(project.client, table, (query) => {
              let next = query
                .select('id, user_id, ' + typeColumn + ', created_at')
                .eq(contentColumn, contentId);
              if (typeValues) next = next.in(typeColumn, typeValues);
              return next
                .order('created_at', { ascending: false })
                .range(offset, offset + limit);
            })
          )
        ),
  ]);

  const allAggregateCounts = countRows(aggregateRows, kind);
  const merged = new Map<string, ReactionRow>();
  for (const row of pageChunks.flat()) {
    const key = rowValue(row, 'id') || `${rowValue(row, 'user_id') || ''}:${rowValue(row, typeColumn) || ''}:${rowValue(row, 'created_at') || ''}`;
    if (!merged.has(key)) merged.set(key, row);
  }
  const ordered = [...merged.values()].sort(compareReactionRows);
  const hasMore = ordered.length > limit;
  const pageRows = ordered.slice(0, limit);
  const users: ReactionUserRow[] = pageRows
    .map((row) => {
      const userId = rowValue(row, 'user_id');
      const typeValue = canonicalReactionType(row[typeColumn], kind);
      const id = rowValue(row, 'id');
      if (!userId || !typeValue || !id) return null;
      return { id, user_id: userId, reaction_type: typeValue, created_at: rowValue(row, 'created_at') };
    })
    .filter((row): row is ReactionUserRow => row !== null);

  const filteredType = canonicalReactionType(options.type, kind);
  const filteredReactionCount = filteredType
    ? allAggregateCounts.reaction_types[filteredType] || 0
    : allAggregateCounts.reaction_count;

  return {
    users,
    reaction_count: allAggregateCounts.reaction_count,
    reaction_types: allAggregateCounts.reaction_types,
    filtered_reaction_count: filteredReactionCount,
    has_more: hasMore,
    next_offset: hasMore ? offset + users.length : null,
  };
}

/**
 * Enrich reaction rows with the deliberately small public profile projection.
 * The reaction endpoint never returns the profiles row itself, and therefore
 * cannot accidentally ship email, phone, relationship, or presence fields.
 */
export async function enrichReactionUsers(
  users: ReactionUserRow[],
  profileProjects: ReactionProject[]
): Promise<PublicReactionUser[]> {
  if (users.length === 0) return [];
  const ids = [...new Set(users.map((user) => user.user_id))];
  const profiles = new Map<string, ReactionRow>();
  await Promise.all(
    profileProjects.map(async (project) => {
      const rows = await queryRows(project.client, 'profiles', (query) =>
        query.select('id, username, display_name, profile_pic').in('id', ids)
      );
      for (const row of rows) {
        const id = rowValue(row, 'id');
        if (id) profiles.set(id, row);
      }
    })
  );

  return users.map((user) => {
    const profile = profiles.get(user.user_id);
    return {
      ...user,
      username: rowValue(profile, 'username') || 'unknown',
      display_name: rowValue(profile, 'display_name') || 'Unknown user',
      profile_pic: rowValue(profile, 'profile_pic'),
    };
  });
}

function toViewerReaction(row: ReactionRow, kind: ReactionContentType): ReactionUserRow | null {
  const id = rowValue(row, 'id');
  const userId = rowValue(row, 'user_id');
  const type = canonicalReactionType(row[REACTION_TYPE_COLUMN[kind]], kind);
  if (!id || !userId || !type) return null;
  return { id, user_id: userId, reaction_type: type, created_at: rowValue(row, 'created_at') };
}

/** Read only the authenticated viewer's own reaction rows for a post/comment. */
export async function getViewerReactionRows(
  projects: ReactionProject[],
  kind: ReactionContentType,
  contentId: string,
  viewerId: string | undefined
): Promise<ReactionUserRow[]> {
  if (!viewerId) return [];
  const table = reactionTable(kind);
  const typeColumn = REACTION_TYPE_COLUMN[kind];
  const contentColumn = CONTENT_ID_COLUMN[kind];
  const chunks = await Promise.all(
    projects.map(async (project) =>
      queryRows(project.client, table, (query) =>
        query
          .select('id, user_id, ' + typeColumn + ', created_at')
          .eq(contentColumn, contentId)
          .eq('user_id', viewerId)
      )
    )
  );
  return chunks
    .flat()
    .map((row) => toViewerReaction(row, kind))
    .filter((row): row is ReactionUserRow => row !== null);
}

export async function getCommentReactionSummaries(
  projects: ReactionProject[],
  commentIds: string[],
  viewerId?: string
): Promise<Map<string, CommentReactionSummary>> {
  const ids = [...new Set(commentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const summaries = new Map<string, CommentReactionSummary>();
  if (ids.length === 0) return summaries;

  const aggregateChunks = await Promise.all(
    projects.map(async (project) =>
      queryRows(project.client, COMMENT_TABLE, (query) => query.select('comment_id, emoji').in('comment_id', ids))
    )
  );
  const aggregateRows = aggregateChunks.flat();
  for (const id of ids) {
    const rows = aggregateRows.filter((row) => rowValue(row, 'comment_id') === id);
    const counts = countRows(rows, 'comment');
    summaries.set(id, { ...counts, viewer_reactions: [] });
  }

  if (viewerId) {
    const viewerChunks = await Promise.all(
      projects.map(async (project) =>
        queryRows(project.client, COMMENT_TABLE, (query) =>
          query
            .select('id, comment_id, user_id, emoji, created_at')
            .in('comment_id', ids)
            .eq('user_id', viewerId)
        )
      )
    );
    for (const row of viewerChunks.flat()) {
      const commentId = rowValue(row, 'comment_id');
      const reaction = toViewerReaction(row, 'comment');
      if (!commentId || !reaction) continue;
      const summary = summaries.get(commentId);
      if (summary) summary.viewer_reactions.push(reaction);
    }
  }

  return summaries;
}

/** Add aggregate fields to comment rows without changing their identity data. */
export function attachCommentReactionSummaries(
  rows: ReactionRow[],
  summaries: Map<string, CommentReactionSummary>
): ReactionRow[] {
  return rows.map((row) => {
    const id = rowValue(row, 'id');
    const summary = id ? summaries.get(id) : undefined;
    const embedded = Array.isArray(row.reactions) ? row.reactions.filter((item): item is ReactionRow => !!item && typeof item === 'object') : [];
    const fallback = countRows(embedded, 'comment');
    return {
      ...row,
      reaction_count: summary?.reaction_count ?? fallback.reaction_count,
      reaction_types: summary?.reaction_types ?? fallback.reaction_types,
    };
  });
}

export function normalizeReactionVisibility(value: unknown): ReactionVisibility {
  if (typeof value !== 'string') return DEFAULT_REACTION_VISIBILITY;
  switch (value.trim().toLowerCase().replace(/[\s-]+/g, '_')) {
    case 'public':
    case 'everyone':
    case 'anyone':
    case 'all':
    case 'true':
      return 'public';
    case 'friends':
    case 'ally':
    case 'allies':
    case 'friends_only':
      return 'friends';
    case 'friends_of_friends':
    case 'friends_of_friends_only':
    case 'wider_circle':
      return 'friends_of_friends';
    case 'only_me':
    case 'private':
    case 'restricted':
    case 'me':
      return 'only_me';
    default:
      return DEFAULT_REACTION_VISIBILITY;
  }
}

export async function getReactionVisibility(
  ownerId: string,
  projects: ReactionProject[]
): Promise<ReactionVisibility> {
  if (!ownerId) return DEFAULT_REACTION_VISIBILITY;
  for (const project of projects) {
    const rows = await queryRows(project.client, 'privacy_settings', (query) =>
      query.select('setting_name, setting_value').eq('user_id', ownerId).in('setting_name', [...REACTION_VISIBILITY_SETTING_NAMES])
    );
    for (const row of rows) {
      const name = rowValue(row, 'setting_name');
      if (name && (REACTION_VISIBILITY_SETTING_NAMES as readonly string[]).includes(name)) {
        return normalizeReactionVisibility(row['setting_value']);
      }
    }
  }
  return DEFAULT_REACTION_VISIBILITY;
}

export async function getAcceptedFriendIds(
  projects: ReactionProject[],
  viewerId: string | undefined
): Promise<Set<string>> {
  if (!viewerId) return new Set();
  const rows = (await Promise.all(
    projects.map(async (project) =>
      queryRows(project.client, 'friends', (query) =>
        query
          .select('requester_id, receiver_id, status')
          .or(`requester_id.eq.${viewerId},receiver_id.eq.${viewerId}`)
      )
    )
  )).flat();
  const friends = new Set<string>();
  for (const row of rows) {
    if (row['status'] !== 'accepted') continue;
    const requester = rowValue(row, 'requester_id');
    const receiver = rowValue(row, 'receiver_id');
    if (!requester || !receiver) continue;
    const other: string = requester === viewerId ? receiver : requester;
    if (other !== viewerId) friends.add(other);
  }
  return friends;
}

async function getFriendOfFriendIds(
  projects: ReactionProject[],
  viewerId: string | undefined,
  directFriends: Set<string>
): Promise<Set<string>> {
  if (!viewerId || directFriends.size === 0) return new Set();
  const ids = [...directFriends];
  const chunks = await Promise.all([
    ...projects.map(async (project) =>
      queryRows(project.client, 'friends', (query) => query.select('requester_id, receiver_id, status').in('requester_id', ids))
    ),
    ...projects.map(async (project) =>
      queryRows(project.client, 'friends', (query) => query.select('requester_id, receiver_id, status').in('receiver_id', ids))
    ),
  ]);
  const result = new Set<string>();
  for (const row of chunks.flat()) {
    if (row['status'] !== 'accepted') continue;
    const requester = rowValue(row, 'requester_id');
    const receiver = rowValue(row, 'receiver_id');
    if (requester && receiver) {
      if (directFriends.has(requester) && receiver !== viewerId) result.add(receiver);
      if (directFriends.has(receiver) && requester !== viewerId) result.add(requester);
    }
  }
  return result;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function canViewerViewPost(
  post: ReactionRow | null | undefined,
  viewerId: string | undefined,
  friendIds: Set<string> = new Set()
): boolean {
  if (!post) return false;
  const ownerId = rowValue(post, 'user_id');
  if (ownerId && ownerId === viewerId) return true;
  if (!viewerId) return isGuestPostVisible(post);

  const visibility = rowValue(post, 'visibility');
  if (visibility && visibility !== 'public') return false;
  const status = rowValue(post, 'status');
  if (status && status !== 'published') return false;

  const audience = rowValue(post, 'audience_type') || 'public';
  if (audience === 'public') return !stringArray(post.audience_excluded_user_ids).includes(viewerId);
  if (audience === 'friends') return friendIds.has(ownerId || '');
  if (audience === 'friends_except') {
    return friendIds.has(ownerId || '') && !stringArray(post.audience_excluded_user_ids).includes(viewerId);
  }
  if (audience === 'specific') return stringArray(post.audience_user_ids).includes(viewerId);
  // Custom audience lists require an additional list-membership reader. Deny
  // here rather than risk serving a private post/reaction list to a stranger.
  if (audience === 'only_me' || audience === 'private' || audience === 'custom_list') return false;
  return false;
}

export function canViewerViewReactionUsers(
  ownerId: string | null,
  viewerId: string | undefined,
  setting: ReactionVisibility,
  contentVisible: boolean,
  friendIds: Set<string> = new Set(),
  friendOfFriendIds: Set<string> = new Set()
): boolean {
  if (!contentVisible || !ownerId) return false;
  if (ownerId === viewerId) return true;
  if (setting === 'public') return true;
  if (!viewerId) return false;
  if (setting === 'friends') return friendIds.has(ownerId);
  if (setting === 'friends_of_friends') return friendIds.has(ownerId) || friendOfFriendIds.has(ownerId);
  return false;
}

export async function resolveReactionContent(
  kind: ReactionContentType,
  contentId: string,
  viewerId: string | undefined,
  deps: ReactionContentDeps
): Promise<ReactionContentResolution> {
  const empty: ReactionContentResolution = {
    status: 'not_found',
    post: null,
    comment: null,
    ownerId: null,
    postId: null,
    contentVisible: false,
    setting: DEFAULT_REACTION_VISIBILITY,
    canViewUsers: false,
  };

  if (kind === 'post') {
    const post = await resolvePost(deps.posts, contentId);
    if (!post) return empty;
    const friendIds = await getAcceptedFriendIds(deps.friends, viewerId);
    const contentVisible = canViewerViewPost(post, viewerId, friendIds);
    if (!contentVisible) return { ...empty, post, postId: contentId, status: 'not_found' };
    const ownerId = rowValue(post, 'user_id');
    const setting = await getReactionVisibility(ownerId || '', deps.privacySettings);
    const friendOfFriendIds = setting === 'friends_of_friends'
      ? await getFriendOfFriendIds(deps.friends, viewerId, friendIds)
      : new Set<string>();
    return {
      status: 'allowed',
      post,
      comment: null,
      ownerId,
      postId: contentId,
      contentVisible,
      setting,
      canViewUsers: canViewerViewReactionUsers(ownerId, viewerId, setting, contentVisible, friendIds, friendOfFriendIds),
    };
  }

  const comment = await resolveComment(deps.comments, contentId);
  if (!comment) return empty;
  const postId = rowValue(comment, 'post_id');
  if (!postId) return { ...empty, comment, status: 'not_found' };
  const post = await resolvePost(deps.posts, postId);
  if (!post) return { ...empty, comment, status: 'not_found' };

  const ownerId = rowValue(comment, 'user_id');
  const friendIds = await getAcceptedFriendIds(deps.friends, viewerId);
  const ownerOfPost = ownerId === viewerId;
  const parentVisible = canViewerViewPost(post, viewerId, friendIds);
  const commentsVisibleToGuest = !viewerId || post.comments_enabled !== false;
  const contentVisible = ownerOfPost || (parentVisible && commentsVisibleToGuest);
  if (!contentVisible) return { ...empty, comment, post, ownerId, postId, status: 'not_found' };

  const setting = await getReactionVisibility(ownerId || '', deps.privacySettings);
  const friendOfFriendIds = setting === 'friends_of_friends'
    ? await getFriendOfFriendIds(deps.friends, viewerId, friendIds)
    : new Set<string>();
  return {
    status: 'allowed',
    post,
    comment,
    ownerId,
    postId,
    contentVisible,
    setting,
    canViewUsers: canViewerViewReactionUsers(ownerId, viewerId, setting, contentVisible, friendIds, friendOfFriendIds),
  };
}

async function resolvePostDecisions(
  rows: ReactionRow[],
  viewerId: string,
  deps: ReactionContentDeps
): Promise<Map<string, ReactionContentResolution>> {
  const ids = rows.map((row) => rowValue(row, 'post_id')).filter((id): id is string => !!id);
  const posts = await resolvePosts(deps.posts, ids);
  const decisions = new Map<string, ReactionContentResolution>();
  const friendIds = await getAcceptedFriendIds(deps.friends, viewerId);
  for (const [postId, post] of posts) {
    const ownerId = rowValue(post, 'user_id');
    const visible = canViewerViewPost(post, viewerId, friendIds);
    const setting = visible ? await getReactionVisibility(ownerId || '', deps.privacySettings) : DEFAULT_REACTION_VISIBILITY;
    decisions.set(postId, {
      status: visible ? 'allowed' : 'not_found',
      post,
      comment: null,
      ownerId,
      postId,
      contentVisible: visible,
      setting,
      canViewUsers: canViewerViewReactionUsers(ownerId, viewerId, setting, visible, friendIds),
    });
  }
  return decisions;
}

export async function filterPostReactionRows(
  rows: ReactionRow[],
  viewerId: string | undefined,
  deps: ReactionContentDeps
): Promise<ReactionRow[]> {
  if (!viewerId || rows.length === 0) return [];
  const decisions = await resolvePostDecisions(rows, viewerId, deps);
  return rows.filter((row) => {
    const postId = rowValue(row, 'post_id');
    const decision = postId ? decisions.get(postId) : undefined;
    return decision?.canViewUsers === true || rowValue(row, 'user_id') === viewerId;
  });
}

export async function filterCommentReactionRows(
  rows: ReactionRow[],
  viewerId: string | undefined,
  deps: ReactionContentDeps
): Promise<ReactionRow[]> {
  if (!viewerId || rows.length === 0) return [];
  const commentIds = rows.map((row) => rowValue(row, 'comment_id')).filter((id): id is string => !!id);
  const comments = await resolveComments(deps.comments, commentIds);
  const postIds = [...comments.values()].map((comment) => rowValue(comment, 'post_id')).filter((id): id is string => !!id);
  const posts = await resolvePosts(deps.posts, postIds);
  const friendIds = await getAcceptedFriendIds(deps.friends, viewerId);
  const decisions = new Map<string, ReactionContentResolution>();

  for (const [commentId, comment] of comments) {
    const ownerId = rowValue(comment, 'user_id');
    const postId = rowValue(comment, 'post_id');
    const post = postId ? posts.get(postId) : undefined;
    const visible = !!post && (ownerId === viewerId || canViewerViewPost(post, viewerId, friendIds));
    const setting = visible ? await getReactionVisibility(ownerId || '', deps.privacySettings) : DEFAULT_REACTION_VISIBILITY;
    decisions.set(commentId, {
      status: visible ? 'allowed' : 'not_found',
      post: post || null,
      comment,
      ownerId,
      postId,
      contentVisible: visible,
      setting,
      canViewUsers: canViewerViewReactionUsers(ownerId, viewerId, setting, visible, friendIds),
    });
  }

  return rows.filter((row) => {
    const commentId = rowValue(row, 'comment_id');
    const decision = commentId ? decisions.get(commentId) : undefined;
    return decision?.canViewUsers === true || rowValue(row, 'user_id') === viewerId;
  });
}
