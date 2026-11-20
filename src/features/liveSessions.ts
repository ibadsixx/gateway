import { auth } from '../auth';
import { canonicalAudienceType } from './contentAudience';
import { defaultDeps as peopleYouMayKnowDeps } from './peopleYouMayKnow';

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
  room_id: string | null;
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
  raised_hand: boolean;
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

const LIVE_DOMAIN = 'live_sessions';

// ---------------------------------------------------------------------------
// In-memory store — used when the live_sessions domain is not registered in the
// gateway's project registry. This allows the live API routes to work
// end-to-end without a dedicated Supabase project.
// ---------------------------------------------------------------------------
const store = new Map<string, Record<string, unknown>[]>();

function table(domain: string): Record<string, unknown>[] {
  let rows = store.get(domain);
  if (!rows) {
    rows = [];
    store.set(domain, rows);
  }
  return rows;
}

function matches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const rowValue = row[key];
    if (value === null) {
      if (rowValue !== null) return false;
    } else if (rowValue !== value) return false;
  }
  return true;
}

async function memRead(domain: string, id: string): Promise<Record<string, unknown> | null> {
  const row = table(domain).find((r) => r.id === id);
  return row ?? null;
}

async function memWrite(domain: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const row = { ...data, id: data.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  table(domain).push(row);
  return row;
}

async function memUpdate(domain: string, id: string, data: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const rows = table(domain);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...data, updated_at: new Date().toISOString() };
  return rows[idx];
}

async function memQuery(domain: string, filter: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  return table(domain).filter((r) => matches(r, filter));
}

async function memDelete(domain: string, id: string): Promise<void> {
  const rows = table(domain);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx !== -1) rows.splice(idx, 1);
}

/**
 * Verify the caller's bearer token and return the authenticated user id.
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
 * Enforce the session's existing Tone audience/privacy rules for an
 * authenticated user. Unknown audience values fail closed. Friend audiences use
 * the Gateway's existing accepted-friendship definition (shared with presence
 * and message-request categorization) rather than a second interpretation.
 * Role/permission decisions are always made from stored server-side state,
 * never from client input.
 */
export async function assertLiveAudienceAccess(session: LiveSessionRow, userId: string): Promise<void> {
  if (session.host_id === userId) return; // the host always has access

  const audience = canonicalAudienceType(session.audience_type) ?? 'denied';
  const allowedIds = new Set<string>(session.audience_user_ids ?? []);
  const excludedIds = new Set<string>(session.audience_excluded_user_ids ?? []);

  switch (audience) {
    case 'public':
      return;
    case 'only_me':
      throw new Error('Access denied: private session');
    case 'specific':
    case 'custom_list':
      if (!allowedIds.has(userId)) throw new Error('Access denied: not on the session audience list');
      return;
    case 'friends': {
      const friends = await peopleYouMayKnowDeps.acceptedFriendIds(session.host_id);
      if (!friends.has(userId)) throw new Error('Access denied: friends-only session');
      return;
    }
    case 'friends_except': {
      const friends = await peopleYouMayKnowDeps.acceptedFriendIds(session.host_id);
      if (!friends.has(userId) || excludedIds.has(userId)) {
        throw new Error('Access denied: friends-only session or excluded user');
      }
      return;
    }
    case 'denied':
    default:
      throw new Error('Access denied: unrecognized session audience');
  }
}

/** Resolve a user's effective role from stored server-side state. */
export function getEffectiveLiveRole(
  session: LiveSessionRow,
  userId: string,
  participant: LiveParticipantRow | null
): LiveParticipantRole {
  if (session.host_id === userId) return 'host';
  return participant?.role ?? 'viewer';
}

/**
 * Authorize a participant action on a session.
 */
export async function authorizeSessionAccess(
  sessionId: string,
  userId: string,
  requiredRole?: LiveParticipantRole
): Promise<{ session: LiveSessionRow; participant: LiveParticipantRow | null }> {
  const session = await memRead(LIVE_DOMAIN, sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  const sessionRow = session as unknown as LiveSessionRow;

  await assertLiveAudienceAccess(sessionRow, userId);

  const participants = await memQuery(LIVE_DOMAIN, { session_id: sessionId, user_id: userId, left_at: null });
  const participant = (participants[0] as unknown as LiveParticipantRow) || null;

  if (requiredRole) {
    const effectiveRole: LiveParticipantRole = sessionRow.host_id === userId ? 'host' : (participant?.role ?? 'viewer');
    const roleRank: Record<LiveParticipantRole, number> = { viewer: 0, guest: 1, moderator: 2, host: 3 };
    if (roleRank[effectiveRole] < roleRank[requiredRole]) {
      throw new Error(`Access denied: requires ${requiredRole} role`);
    }
  }

  return { session: sessionRow, participant };
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
  // Media is direct browser-to-browser WebRTC; there is no media server room.
  // `room_id` is retained as a legacy field for older clients and is null.

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
    room_id: null,
  };

  const created = await memWrite(LIVE_DOMAIN, row as Record<string, unknown>);
  return created as unknown as LiveSessionRow;
}

export async function getLiveSession(sessionId: string): Promise<LiveSessionRow | null> {
  const session = await memRead(LIVE_DOMAIN, sessionId);
  return (session as unknown as LiveSessionRow) || null;
}

export async function getActiveLiveSessions(): Promise<LiveSessionRow[]> {
  const rows = await memQuery(LIVE_DOMAIN, { status: 'live' });
  return rows as unknown as LiveSessionRow[];
}

export async function updateLiveSession(
  sessionId: string,
  data: Partial<LiveSessionRow>
): Promise<LiveSessionRow | null> {
  const result = await memUpdate(LIVE_DOMAIN, sessionId, data as Record<string, unknown>);
  return (result as unknown as LiveSessionRow) || null;
}

export async function endLiveSession(sessionId: string): Promise<LiveSessionRow | null> {
  const session = await memRead(LIVE_DOMAIN, sessionId);
  if (!session) return null;

  // Idempotent: ending an already-ended session is a no-op update.
  return updateLiveSession(sessionId, {
    status: 'ended',
    ended_at: (session as unknown as LiveSessionRow).ended_at ?? new Date().toISOString(),
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
  const result = await memWrite(LIVE_DOMAIN, row as Record<string, unknown>);
  return result as unknown as LiveParticipantRow;
}

export async function getSessionParticipants(sessionId: string): Promise<LiveParticipantRow[]> {
  const rows = await memQuery(LIVE_DOMAIN, { session_id: sessionId, left_at: null });
  return rows as unknown as LiveParticipantRow[];
}

export async function updateLiveParticipant(
  sessionId: string,
  userId: string,
  data: Partial<LiveParticipantRow>
): Promise<LiveParticipantRow | null> {
  const rows = await memQuery(LIVE_DOMAIN, { session_id: sessionId, user_id: userId, left_at: null });
  const participant = (rows[0] as unknown as LiveParticipantRow) || null;
  if (!participant) return null;

  const result = await memUpdate(LIVE_DOMAIN, participant.id, data as Record<string, unknown>);
  return (result as unknown as LiveParticipantRow) || null;
}

export async function leaveLiveSession(sessionId: string, userId: string): Promise<void> {
  const rows = await memQuery(LIVE_DOMAIN, { session_id: sessionId, user_id: userId, left_at: null });
  const participant = (rows[0] as unknown as LiveParticipantRow) || null;
  if (!participant) return;

  await memUpdate(LIVE_DOMAIN, participant.id, { left_at: new Date().toISOString() } as Record<string, unknown>);
}

export async function raiseHand(sessionId: string, userId: string): Promise<LiveParticipantRow | null> {
  const rows = await memQuery(LIVE_DOMAIN, { session_id: sessionId, user_id: userId, left_at: null });
  const participant = (rows[0] as unknown as LiveParticipantRow) || null;
  if (!participant) return null;

  const result = await memUpdate(LIVE_DOMAIN, participant.id, { raised_hand: true } as Record<string, unknown>);
  return (result as unknown as LiveParticipantRow) || null;
}

export async function lowerHand(sessionId: string, userId: string): Promise<LiveParticipantRow | null> {
  const rows = await memQuery(LIVE_DOMAIN, { session_id: sessionId, user_id: userId, left_at: null });
  const participant = (rows[0] as unknown as LiveParticipantRow) || null;
  if (!participant) return null;

  const result = await memUpdate(LIVE_DOMAIN, participant.id, { raised_hand: false } as Record<string, unknown>);
  return (result as unknown as LiveParticipantRow) || null;
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
  const result = await memWrite(LIVE_DOMAIN, row as Record<string, unknown>);
  return result as unknown as LiveCommentRow;
}

export async function getLiveComments(sessionId: string, limit = 50): Promise<LiveCommentRow[]> {
  const rows = await memQuery(LIVE_DOMAIN, { session_id: sessionId, is_hidden: false });
  const sorted = (rows as unknown[]).sort(
    (a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at))
  );
  return sorted.slice(0, limit) as unknown as LiveCommentRow[];
}

export async function hideComment(commentId: string): Promise<void> {
  await memUpdate(LIVE_DOMAIN, commentId, {
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
  const result = await memWrite(LIVE_DOMAIN, row as Record<string, unknown>);
  return result as unknown as LiveReactionRow;
}

export async function getLiveReactions(sessionId: string): Promise<LiveReactionRow[]> {
  const rows = await memQuery(LIVE_DOMAIN, { session_id: sessionId });
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
  const result = await memWrite(LIVE_DOMAIN, row as Record<string, unknown>);
  return result as unknown as LiveRecordingRow;
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
  const result = await memWrite(LIVE_DOMAIN, row as Record<string, unknown>);
  return result as unknown as LiveReportRow;
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
  const result = await memWrite(LIVE_DOMAIN, row as Record<string, unknown>);
  return result as unknown as LiveEventRow;
}
