import { database } from '../infrastructure/database';
import { projectManager } from '../project-manager';
import { auth } from '../auth';
import { notificationQueue } from '../notifications';

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
  // Read the session by id
  const session = await database.read(LIVE_DOMAIN, sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  const sessionRow = session as unknown as LiveSessionRow;

  // Audience enforcement: public sessions are readable by anyone;
  // friends-only sessions require the viewer to be a friend of the host.
  if (sessionRow.audience_type === 'friends' && sessionRow.host_id !== userId) {
    const hostFriends = await getFriendIds(sessionRow.host_id);
    if (!hostFriends.includes(userId)) {
      throw new Error('Access denied: friends-only session');
    }
  }

  // Read the caller's participant row (if joined)
  const participants = await database.query(LIVE_DOMAIN, {
    session_id: sessionId,
    user_id: userId,
    left_at: null,
  });
  const participant = (participants[0] as unknown as LiveParticipantRow) || null;

  if (requiredRole && participant) {
    const roleRank: Record<LiveParticipantRole, number> = { viewer: 0, guest: 1, moderator: 2, host: 3 };
    if (roleRank[participant.role] < roleRank[requiredRole]) {
      throw new Error(`Access denied: requires ${requiredRole} role`);
    }
  }

  return { session: sessionRow, participant };
}

/** Resolve the authenticated user's accepted friend ids (from the users project). */
async function getFriendIds(userId: string): Promise<string[]> {
  try {
    const rows = await database.query('users', {
      requester_id: userId,
      status: 'accepted',
    });
    return (rows as unknown[]).map((r: any) => r.receiver_id).filter(Boolean);
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

  const result = await database.write(LIVE_DOMAIN, row as Record<string, unknown>);
  const created = (Array.isArray(result) ? result[0] : result) as unknown as LiveSessionRow;

  // Emit a session_created event for notifications + moderation consumers.
  await recordLiveEvent({
    session_id: created.id,
    event_type: 'session_created',
    actor_id: data.host_id,
  });

  // Notify the host's friends that they are live (public or friends audience).
  if (data.audience_type !== 'only_me') {
    try {
      const friendIds = await getFriendIds(data.host_id);
      for (const friendId of friendIds) {
        notificationQueue.enqueue({
          userId: friendId,
          type: 'IN_APP',
          title: `${data.title ?? 'Live Stream'} is now live`,
          body: `${data.host_id} started a ${data.stream_type} live stream`,
          payload: { session_id: created.id, stream_type: data.stream_type },
        });
      }
    } catch {
      // Notification failures must not fail session creation.
    }
  }

  return created;
}

export async function getLiveSession(sessionId: string): Promise<LiveSessionRow | null> {
  const session = await database.read(LIVE_DOMAIN, sessionId);
  return (session as unknown as LiveSessionRow) || null;
}

export async function getActiveLiveSessions(): Promise<LiveSessionRow[]> {
  const rows = await database.query(LIVE_DOMAIN, { status: 'live' });
  return rows as unknown as LiveSessionRow[];
}

export async function updateLiveSession(
  sessionId: string,
  data: Partial<LiveSessionRow>
): Promise<LiveSessionRow | null> {
  const result = await database.update(LIVE_DOMAIN, sessionId, data as Record<string, unknown>);
  return (result as unknown as LiveSessionRow) || null;
}

export async function endLiveSession(sessionId: string): Promise<LiveSessionRow | null> {
  return updateLiveSession(sessionId, {
    status: 'ended',
    ended_at: new Date().toISOString(),
  });
}

// ============================================================================
// Participants
// ============================================================================

export async function addLiveParticipant(data: {
  session_id: string;
  user_id: string;
  role?: LiveParticipantRole;
}): Promise<LiveParticipantRow> {
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
  const result = await database.write(LIVE_DOMAIN, row as Record<string, unknown>);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveParticipantRow;
}

export async function getSessionParticipants(sessionId: string): Promise<LiveParticipantRow[]> {
  const rows = await database.query(LIVE_DOMAIN, {
    session_id: sessionId,
    left_at: null,
  });
  return rows as unknown as LiveParticipantRow[];
}

export async function updateLiveParticipant(
  sessionId: string,
  userId: string,
  data: Partial<LiveParticipantRow>
): Promise<LiveParticipantRow | null> {
  // Find the participant row first (the gateway's update takes a single id).
  const rows = await database.query(LIVE_DOMAIN, {
    session_id: sessionId,
    user_id: userId,
    left_at: null,
  });
  const participant = (rows[0] as unknown as LiveParticipantRow) || null;
  if (!participant) return null;

  const result = await database.update(LIVE_DOMAIN, participant.id, data as Record<string, unknown>);
  return (result as unknown as LiveParticipantRow) || null;
}

export async function leaveLiveSession(sessionId: string, userId: string): Promise<void> {
  const rows = await database.query(LIVE_DOMAIN, {
    session_id: sessionId,
    user_id: userId,
    left_at: null,
  });
  const participant = (rows[0] as unknown as LiveParticipantRow) || null;
  if (!participant) return;

  await database.update(LIVE_DOMAIN, participant.id, {
    left_at: new Date().toISOString(),
  } as Record<string, unknown>);
}

// ============================================================================
// Comments
// ============================================================================

export async function addLiveComment(data: {
  session_id: string;
  user_id: string;
  content: string;
}): Promise<LiveCommentRow> {
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
  const result = await database.write(LIVE_DOMAIN, row as Record<string, unknown>);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveCommentRow;
}

export async function getLiveComments(sessionId: string, limit = 50): Promise<LiveCommentRow[]> {
  const rows = await database.query(LIVE_DOMAIN, {
    session_id: sessionId,
    is_hidden: false,
  });
  // Apply ordering + limit client-side (gateway query() does eq filters only).
  const sorted = (rows as unknown[]).sort(
    (a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at))
  );
  return sorted.slice(0, limit) as unknown as LiveCommentRow[];
}

export async function hideComment(commentId: string): Promise<void> {
  await database.update(LIVE_DOMAIN, commentId, {
    is_hidden: true,
    hidden_at: new Date().toISOString(),
  } as Record<string, unknown>);
}

// ============================================================================
// Reactions
// ============================================================================

export async function addLiveReaction(data: {
  session_id: string;
  user_id: string;
  reaction_type: string;
}): Promise<LiveReactionRow> {
  const now = new Date().toISOString();
  const row: Partial<LiveReactionRow> = {
    id: crypto.randomUUID(),
    session_id: data.session_id,
    user_id: data.user_id,
    reaction_type: data.reaction_type,
    created_at: now,
  };
  const result = await database.write(LIVE_DOMAIN, row as Record<string, unknown>);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveReactionRow;
}

export async function getLiveReactions(sessionId: string): Promise<LiveReactionRow[]> {
  const rows = await database.query(LIVE_DOMAIN, { session_id: sessionId });
  return rows as unknown as LiveReactionRow[];
}

// ============================================================================
// Recordings
// ============================================================================

export async function addLiveRecording(data: {
  session_id: string;
}): Promise<LiveRecordingRow> {
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
  const result = await database.write(LIVE_DOMAIN, row as Record<string, unknown>);
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
  const result = await database.write(LIVE_DOMAIN, row as Record<string, unknown>);
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
  const result = await database.write(LIVE_DOMAIN, row as Record<string, unknown>);
  return (Array.isArray(result) ? result[0] : result) as unknown as LiveEventRow;
}
