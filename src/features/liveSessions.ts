import { database } from '../infrastructure/database';
import { projectManager } from '../project-manager';
import { auth } from '../auth';

export type LiveStreamType = 'video' | 'audio';
export type LiveSessionStatus = 'scheduled' | 'live' | 'ended';
export type LiveAudienceType = 'public' | 'friends' | 'friends_except' | 'specific' | 'only_me' | 'custom_list';
export type LiveParticipantRole = 'host' | 'moderator' | 'guest' | 'viewer';

export interface LiveSessionRow {
  id: string;
  host_id: string;
  title: string | null;
  description: string | null;
  stream_type: LiveStreamType;
  status: LiveSessionStatus;
  audience_type: LiveAudienceType;
  audience_user_ids: string[] | null;
  audience_excluded_user_ids: string[] | null;
  audience_list_id: string | null;
  recording: boolean;
  recording_url: string | null;
  viewer_count: number;
  max_viewers: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveParticipantRow {
  id: string;
  session_id: string;
  user_id: string;
  role: LiveParticipantRole;
  joined_at: string | null;
  left_at: string | null;
  is_muted: boolean;
  is_video_off: boolean;
}

export interface LiveInviteRow {
  id: string;
  session_id: string;
  inviter_id: string;
  invitee_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  created_at: string;
  responded_at: string | null;
}

export interface LiveCommentRow {
  id: string;
  session_id: string;
  user_id: string;
  content: string;
  created_at: string;
  is_hidden: boolean;
  hidden_by: string | null;
  hidden_at: string | null;
}

export interface LiveReactionRow {
  id: string;
  session_id: string;
  user_id: string;
  reaction_type: string;
  created_at: string;
}

export interface LiveRecordingRow {
  id: string;
  session_id: string;
  status: 'pending' | 'recording' | 'completed' | 'failed';
  url: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
}

export interface LiveReportRow {
  id: string;
  session_id: string;
  reporter_id: string;
  reported_user_id: string | null;
  reason: string;
  description: string | null;
  status: 'open' | 'reviewed' | 'resolved';
  created_at: string;
}

export interface LiveEventRow {
  id: string;
  session_id: string;
  event_type: string;
  actor_id: string | null;
  target_user_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const LIVE_DOMAIN = 'live-1';

/**
 * Resolve the live-1 writable project. The eight live tables are hosted on the
 * live-1 Supabase project and reached through the Gateway's database layer,
 * which routes per-domain to the registered project.
 */
async function getLiveClient() {
  const writable = projectManager.getWritableProject(LIVE_DOMAIN);
  if (!writable) {
    throw new Error(`No writable project for domain: ${LIVE_DOMAIN}`);
  }
  return writable.client;
}

/**
 * Verify the caller's bearer token and return the authenticated user id.
 * Throws on missing/invalid token so routes never authorize an anonymous
 * caller for a write path.
 */
async function requireUserId(req: { headers: Record<string, string | undefined> }): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new Error('Missing authorization header');
  }
  const token = header.split(' ')[1];
  const user = await auth.verifyToken(token);
  if (!user) {
    throw new Error('Invalid or expired token');
  }
  return user.id;
}

/**
 * Authorize a participant action on a session. Returns the session row and the
 * caller's participant row (if joined). Roles:
 * - host: full control (start/end/record/moderate)
 * - moderator: can mute/remove participants, hide comments
 * - guest: can publish audio/video media tracks
 * - viewer: read-only (audio/video receive)
 */
export async function authorizeSessionAccess(
  sessionId: string,
  userId: string,
  requiredRole?: LiveParticipantRole
): Promise<{ session: LiveSessionRow; participant: LiveParticipantRow | null }> {
  const client = await getLiveClient();

  // Read the session
  const sessionRes = await database.query(LIVE_DOMAIN, {
    table: 'live_sessions',
    filters: [{ column: 'id', op: 'eq', value: sessionId }],
  } as any);
  const sessions = (sessionRes as any[]) || [];
  const session = sessions[0] as unknown as LiveSessionRow | undefined;
  if (!session) {
    throw new Error('Session not found');
  }

  // Audience enforcement: public sessions are readable by anyone; friends-only
  // sessions require the viewer to be a friend of the host.
  if (session.audience_type === 'friends' && session.host_id !== userId) {
    const hostFriends = await getFriendIds(session.host_id);
    if (!hostFriends.includes(userId)) {
      throw new Error('Access denied: friends-only session');
    }
  }

  // Read the caller's participant row (if any)
  const participantRes = await database.query(LIVE_DOMAIN, {
    table: 'live_participants',
    filters: [
      { column: 'session_id', op: 'eq', value: sessionId },
      { column: 'user_id', op: 'eq', value: userId },
      { column: 'left_at', op: 'is', value: null },
    ],
  } as any);
  const participants = (participantRes as any[]) || [];
  const participant = participants[0] as unknown as LiveParticipantRow | null;

  if (requiredRole && participant) {
    const roleRank: Record<LiveParticipantRole, number> = { viewer: 0, guest: 1, moderator: 2, host: 3 };
    if (roleRank[participant.role] < roleRank[requiredRole]) {
      throw new Error(`Access denied: requires ${requiredRole} role`);
    }
  }

  return { session, participant };
}

/** Resolve the authenticated user's accepted friend ids (from the users project). */
async function getFriendIds(userId: string): Promise<string[]> {
  try {
    const friendsRes = await database.query('users', {
      table: 'friends',
      filters: [
        { column: 'requester_id', op: 'eq', value: userId },
        { column: 'status', op: 'eq', value: 'accepted' },
      ],
    } as any);
    const rows = (friendsRes as any[]) || [];
    return rows.map((r: any) => r.receiver_id).filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================================
// Session CRUD
// ============================================================================

export async function createLiveSession(data: {
  host_id: string;
  title?: string;
  description?: string;
  stream_type: LiveStreamType;
  audience_type?: LiveAudienceType;
  audience_user_ids?: string[] | null;
  audience_excluded_user_ids?: string[] | null;
  audience_list_id?: string | null;
  recording?: boolean;
  max_viewers?: number | null;
}): Promise<LiveSessionRow> {
  const client = await getLiveClient();
  const now = new Date().toISOString();
  const row: Partial<LiveSessionRow> = {
    id: crypto.randomUUID(),
    host_id: data.host_id,
    title: data.title ?? null,
    description: data.description ?? null,
    stream_type: data.stream_type,
    status: 'scheduled',
    audience_type: data.audience_type ?? 'public',
    audience_user_ids: data.audience_user_ids ?? null,
    audience_excluded_user_ids: data.audience_excluded_user_ids ?? null,
    audience_list_id: data.audience_list_id ?? null,
    recording: data.recording ?? false,
    recording_url: null,
    viewer_count: 0,
    max_viewers: data.max_viewers ?? null,
    started_at: null,
    ended_at: null,
    created_at: now,
    updated_at: now,
  };

  const result = await database.write(LIVE_DOMAIN, row as any);
  const created = (Array.isArray(result) ? result[0] : result) as unknown as LiveSessionRow;
  return created;
}

export async function getLiveSession(sessionId: string): Promise<LiveSessionRow | null> {
  const client = await getLiveClient();
  const result = await database.query(LIVE_DOMAIN, {
    table: 'live_sessions',
    filters: [{ column: 'id', op: 'eq', value: sessionId }],
  } as any);
  const sessions = (result as any[]) || [];
  return (sessions[0] as unknown as LiveSessionRow) || null;
}

export async function getActiveLiveSessions(): Promise<LiveSessionRow[]> {
  const client = await getLiveClient();
  const result = await database.query(LIVE_DOMAIN, {
    table: 'live_sessions',
    filters: [{ column: 'status', op: 'eq', value: 'live' }],
  } as any);
  return (result as any[]) || [];
}

export async function updateLiveSession(
  sessionId: string,
  data: Partial<LiveSessionRow>
): Promise<LiveSessionRow | null> {
  const client = await getLiveClient();
  const result = await database.update(LIVE_DOMAIN, sessionId, data as any);
  return (result as unknown as LiveSessionRow) || null;
}

export async function endLiveSession(sessionId: string): Promise<LiveSessionRow | null> {
  return updateLiveSession(sessionId, {
    status: 'ended',
    ended_at: new Date().toISOString(),
  });
}

export async function incrementViewerCount(sessionId: string): Promise<void> {
  await database.update(LIVE_DOMAIN, sessionId, {
    viewer_count: -1, // sentinel handled client-side by gateway; see incrementViewerCountBy
  } as any);
}

// ============================================================================
// Participants
// ============================================================================

export async function addLiveParticipant(data: {
  session_id: string;
  user_id: string;
  role?: LiveParticipantRole;
}): Promise<LiveParticipantRow> {
  const client = await getLiveClient();
  const now = new Date().toISOString();
  const row: Partial<LiveParticipantRow> = {
    id: crypto.randomUUID(),
    session_id: data.session_id,
    user_id: data.user_id,
    role: data.role ?? 'viewer',
    joined_at: now,
    left_at: null,
    is_muted: false,
    is_video_off: false,
  };
  const result = await database.write(LIVE_DOMAIN, row as any);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveParticipantRow;
}

export async function getSessionParticipants(sessionId: string): Promise<LiveParticipantRow[]> {
  const client = await getLiveClient();
  const result = await database.query(LIVE_DOMAIN, {
    table: 'live_participants',
    filters: [
      { column: 'session_id', op: 'eq', value: sessionId },
      { column: 'left_at', op: 'is', value: null },
    ],
  } as any);
  return (result as any[]) || [];
}

export async function updateLiveParticipant(
  sessionId: string,
  userId: string,
  data: Partial<LiveParticipantRow>
): Promise<LiveParticipantRow | null> {
  const client = await getLiveClient();
  // Use the gateway's update-by-filters path via query + write; fall back to
  // the domain write with a composite filter key.
  const result = await database.write(LIVE_DOMAIN, {
    ...data,
    session_id: sessionId,
    user_id: userId,
    _match: { session_id: sessionId, user_id: userId, left_at: null },
  } as any);
  return (result as unknown as LiveParticipantRow) || null;
}

export async function leaveLiveSession(sessionId: string, userId: string): Promise<void> {
  await database.update(LIVE_DOMAIN, `${sessionId}:${userId}`, {
    left_at: new Date().toISOString(),
  } as any);
}

// ============================================================================
// Comments
// ============================================================================

export async function addLiveComment(data: {
  session_id: string;
  user_id: string;
  content: string;
}): Promise<LiveCommentRow> {
  const client = await getLiveClient();
  const now = new Date().toISOString();
  const row: Partial<LiveCommentRow> = {
    id: crypto.randomUUID(),
    session_id: data.session_id,
    user_id: data.user_id,
    content: data.content,
    created_at: now,
    is_hidden: false,
    hidden_by: null,
    hidden_at: null,
  };
  const result = await database.write(LIVE_DOMAIN, row as any);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveCommentRow;
}

export async function getLiveComments(sessionId: string, limit = 50): Promise<LiveCommentRow[]> {
  const client = await getLiveClient();
  const result = await database.query(LIVE_DOMAIN, {
    table: 'live_comments',
    filters: [
      { column: 'session_id', op: 'eq', value: sessionId },
      { column: 'is_hidden', op: 'eq', value: false },
    ],
  } as any);
  return (result as any[]) || [];
}

// ============================================================================
// Reactions
// ============================================================================

export async function addLiveReaction(data: {
  session_id: string;
  user_id: string;
  reaction_type: string;
}): Promise<LiveReactionRow> {
  const client = await getLiveClient();
  const now = new Date().toISOString();
  const row: Partial<LiveReactionRow> = {
    id: crypto.randomUUID(),
    session_id: data.session_id,
    user_id: data.user_id,
    reaction_type: data.reaction_type,
    created_at: now,
  };
  const result = await database.write(LIVE_DOMAIN, row as any);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveReactionRow;
}

export async function getLiveReactions(sessionId: string): Promise<LiveReactionRow[]> {
  const client = await getLiveClient();
  const result = await database.query(LIVE_DOMAIN, {
    table: 'live_reactions',
    filters: [{ column: 'session_id', op: 'eq', value: sessionId }],
  } as any);
  return (result as any[]) || [];
}

// ============================================================================
// Recordings
// ============================================================================

export async function addLiveRecording(data: {
  session_id: string;
}): Promise<LiveRecordingRow> {
  const client = await getLiveClient();
  const now = new Date().toISOString();
  const row: Partial<LiveRecordingRow> = {
    id: crypto.randomUUID(),
    session_id: data.session_id,
    status: 'pending',
    url: null,
    started_at: now,
    ended_at: null,
    duration_seconds: null,
  };
  const result = await database.write(LIVE_DOMAIN, row as any);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveRecordingRow;
}

// ============================================================================
// Reports
// ============================================================================

export async function submitLiveReport(data: {
  session_id: string;
  reporter_id: string;
  reported_user_id?: string | null;
  reason: string;
  description?: string | null;
}): Promise<LiveReportRow> {
  const client = await getLiveClient();
  const now = new Date().toISOString();
  const row: Partial<LiveReportRow> = {
    id: crypto.randomUUID(),
    session_id: data.session_id,
    reporter_id: data.reporter_id,
    reported_user_id: data.reported_user_id ?? null,
    reason: data.reason,
    description: data.description ?? null,
    status: 'open',
    created_at: now,
  };
  const result = await database.write(LIVE_DOMAIN, row as any);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveReportRow;
}

// ============================================================================
// Events
// ============================================================================

export async function recordLiveEvent(data: {
  session_id: string;
  event_type: string;
  actor_id?: string | null;
  target_user_id?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<LiveEventRow> {
  const client = await getLiveClient();
  const now = new Date().toISOString();
  const row: Partial<LiveEventRow> = {
    id: crypto.randomUUID(),
    session_id: data.session_id,
    event_type: data.event_type,
    actor_id: data.actor_id ?? null,
    target_user_id: data.target_user_id ?? null,
    metadata: data.metadata ?? null,
    created_at: now,
  };
  const result = await database.write(LIVE_DOMAIN, row as any);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveEventRow;
}
