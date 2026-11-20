import express, { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { auth } from '../auth';
import { database } from '../infrastructure/database';
import {
  createLiveSession,
  getLiveSession,
  getActiveLiveSessions,
  updateLiveSession,
  endLiveSession,
  addLiveParticipant,
  getSessionParticipants,
  updateLiveParticipant,
  leaveLiveSession,
  addLiveComment,
  getLiveComments,
  hideComment,
  addLiveReaction,
  getLiveReactions,
  addLiveRecording,
  submitLiveReport,
  recordLiveEvent,
  raiseHand,
  lowerHand,
  authorizeSessionAccess,
  assertLiveAudienceAccess,
  getEffectiveLiveRole,
  type LiveSessionRow,
  type LiveParticipantRow,
  type LiveCommentRow,
  type LiveReactionRow,
  type LiveRecordingRow,
  type LiveReportRow,
  type LiveEventRow,
  type LiveStreamType,
  type LiveSessionStatus,
  type LiveAudienceType,
  type LiveParticipantRole,
} from '../features/liveSessions';
import { createSignalingTicket, storeSignalingMessage } from '../features/liveSignalingStore';
import type { ServerSignalingMessage, ParticipantStatePayload } from '../features/liveSignalingProtocol';

/**
 * Publish a durable, WebSocket-deliverable state event. All role/session
 * authorization happens in the calling route; this helper only writes the
 * Gateway-authored event to the shared signaling store.
 */
async function publishDurableState(input: {
  sessionId: string;
  fromUserId: string;
  type: ServerSignalingMessage['type'];
  role: ServerSignalingMessage['role'];
  toUserId?: string;
  state?: ParticipantStatePayload;
}): Promise<void> {
  try {
    await storeSignalingMessage({
      id: randomUUID(),
      sessionId: input.sessionId,
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      type: input.type,
      role: input.role,
      state: input.state,
      ttlSeconds: 120,
    });
  } catch (error) {
    // The REST mutation itself has already succeeded; never fail it because a
    // transient signaling write failed. Peers reconcile from REST on reconnect.
    console.error('[Live] durable state publish failed:', (error as Error).message);
  }
}

const liveRouter = Router();

// Apply authentication to all live routes
liveRouter.use(auth.authenticate.bind(auth));

const requireBody = (req: Request, res: Response, fields: string[]): Record<string, unknown> | null => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return null;
  }
  for (const f of fields) {
    if (!(f in body)) {
      res.status(400).json({ error: `Missing required field: ${f}` });
      return null;
    }
  }
  return body as Record<string, unknown>;
};

// ============================================================================
// Sessions
// ============================================================================

/** Create a new live session. The caller becomes the host. */
liveRouter.post('/sessions', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const body = requireBody(req, res, ['stream_type']);
    if (!body) return;

    const streamType = body.stream_type as LiveStreamType;
    if (streamType !== 'video' && streamType !== 'audio') {
      res.status(400).json({ error: 'stream_type must be "video" or "audio"' });
      return;
    }

    const session = await createLiveSession({
      host_id: userId,
      title: body.title as string | undefined,
      description: body.description as string | undefined,
      stream_type: streamType,
      audience_type: (body.audience_type as LiveAudienceType) ?? 'public',
      audience_user_ids: body.audience_user_ids as string[] | null | undefined,
      audience_excluded_user_ids: body.audience_excluded_user_ids as string[] | null | undefined,
      audience_list_id: body.audience_list_id as string | null | undefined,
      recording: (body.recording as boolean) ?? false,
      max_viewers: body.max_viewers as number | null | undefined,
    });

    // Record the session-started event and add the host as a participant.
    await recordLiveEvent({
      session_id: session.id,
      event_type: 'session_created',
      actor_id: userId,
    });
    await addLiveParticipant({ session_id: session.id, user_id: userId, role: 'host' });

    res.status(201).json(session);
  } catch (error) {
    console.error('[Live] create session failed:', (error as Error).message);
    res.status(500).json({ error: (error as Error).message || 'Failed to create session' });
  }
});

/** Get a single live session by id. */
liveRouter.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const session = await getLiveSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (error) {
    console.error('[Live] get session failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/** List all currently live sessions. */
liveRouter.get('/sessions', async (_req: Request, res: Response) => {
  try {
    const sessions = await getActiveLiveSessions();
    res.json(sessions);
  } catch (error) {
    console.error('[Live] list sessions failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/** Update a live session (host only). */
liveRouter.put('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const body = requireBody(req, res, []);
    if (!body) return;

    const session = await getLiveSession(id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.host_id !== userId) {
      res.status(403).json({ error: 'Only the host can update the session' });
      return;
    }

    const updated = await updateLiveSession(id, {
      title: body.title,
      description: body.description,
      stream_type: body.stream_type as LiveStreamType | undefined,
      audience_type: body.audience_type as LiveAudienceType | undefined,
      audience_user_ids: body.audience_user_ids,
      audience_excluded_user_ids: body.audience_excluded_user_ids,
      audience_list_id: body.audience_list_id,
      recording: body.recording as boolean | undefined,
      max_viewers: body.max_viewers,
    } as any);
    if (!updated) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(updated);
  } catch (error) {
    console.error('[Live] update session failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

/** End a live session (host only). */
liveRouter.post('/sessions/:id/end', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const session = await getLiveSession(id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.host_id !== userId) {
      res.status(403).json({ error: 'Only the host can end the session' });
      return;
    }

    const ended = await endLiveSession(id);
    if (!ended) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Durable session-ended event; delivered to every connected peer.
    await publishDurableState({ sessionId: id, fromUserId: userId, type: 'session-ended', role: 'host' });
    await recordLiveEvent({ session_id: id, event_type: 'session_ended', actor_id: userId });

    res.json(ended);
  } catch (error) {
    console.error('[Live] end session failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// ============================================================================
// Participants
// ============================================================================

/** Join a live session. Adds a participant row and broadcasts join. */
liveRouter.post('/sessions/:id/participants', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;
    const body = requireBody(req, res, []);
    if (!body) return;

    const session = await getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'live' && session.status !== 'scheduled') {
      res.status(400).json({ error: 'Session is not active' });
      return;
    }

    // Enforce the session's existing Tone audience/privacy rules.
    try {
      await assertLiveAudienceAccess(session, userId);
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
      return;
    }

    // Never trust a client-supplied role. Joiners always start as viewers;
    // promotion to guest/moderator is a separate Gateway-authorized action.
    const role: LiveParticipantRole = 'viewer';
    const participant = await addLiveParticipant({
      session_id: sessionId,
      user_id: userId,
      role,
    });

    // Existing peers create offers when they see this durable join event.
    await publishDurableState({ sessionId, fromUserId: userId, type: 'join', role: 'viewer' });
    await recordLiveEvent({
      session_id: sessionId,
      event_type: 'participant_joined',
      actor_id: userId,
      target_user_id: userId,
    });

    res.status(201).json(participant);
  } catch (error) {
    console.error('[Live] join session failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to join session' });
  }
});

/** Get participants in a session. */
liveRouter.get('/sessions/:id/participants', async (req: Request, res: Response) => {
  try {
    const { id: sessionId } = req.params;
    const participants = await getSessionParticipants(sessionId);
    res.json(participants);
  } catch (error) {
    console.error('[Live] get participants failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to get participants' });
  }
});

/** Update participant state (mute, video off, role). Host/moderator or self. */
liveRouter.put('/sessions/:id/participants/:userId', async (req: Request, res: Response) => {
  try {
    const callerId = req.user!.id;
    const { id: sessionId, userId } = req.params;
    const body = requireBody(req, res, []);
    if (!body) return;

    // Authorize: host/moderator can moderate any participant; a user can only
    // moderate themselves (mute/unmute own audio/video).
    const { session, participant: callerParticipant } = await authorizeSessionAccess(sessionId, callerId);
    const isSelf = userId === callerId;
    const isHostOrMod = callerParticipant &&
      (callerParticipant.role === 'host' || callerParticipant.role === 'moderator');

    if (!isSelf && !isHostOrMod) {
      res.status(403).json({ error: 'Only hosts and moderators can moderate other participants' });
      return;
    }

    // A non-host cannot change another user's role.
    if (body.role !== undefined && !isHostOrMod) {
      res.status(403).json({ error: 'Only the host can change participant roles' });
      return;
    }

    const participant = await updateLiveParticipant(sessionId, userId, {
      is_muted: body.is_muted,
      is_video_off: body.is_video_off,
      role: body.role as LiveParticipantRole | undefined,
    } as any);

    if (!participant) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }

    // Durable state update so every peer sees the new role/mute/video state.
    await publishDurableState({
      sessionId,
      fromUserId: callerId,
      type: 'participant-state',
      role: session.host_id === callerId ? 'host' : (callerParticipant?.role ?? 'viewer'),
      state: {
        targetUserId: userId,
        role: participant.role as ParticipantStatePayload['role'],
        ...(participant.is_muted !== undefined ? { isMuted: participant.is_muted } : {}),
        ...(participant.is_video_off !== undefined ? { isVideoOff: participant.is_video_off } : {}),
      },
    });

    res.json(participant);
  } catch (error) {
    console.error('[Live] update participant failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to update participant' });
  }
});

/**
 * Remove another participant. Hosts and moderators only; the host can never be
 * removed. Used by the host UI's participant moderation controls.
 */
liveRouter.delete('/sessions/:id/participants/:userId', async (req: Request, res: Response) => {
  try {
    const callerId = req.user!.id;
    const { id: sessionId, userId: targetUserId } = req.params;
    const { session, participant: caller } = await authorizeSessionAccess(sessionId, callerId, 'moderator');

    if (targetUserId === session.host_id) {
      res.status(403).json({ error: 'The host cannot be removed' });
      return;
    }
    if (targetUserId !== callerId && session.host_id !== callerId && caller?.role !== 'moderator') {
      res.status(403).json({ error: 'Not authorized to remove this participant' });
      return;
    }

    await leaveLiveSession(sessionId, targetUserId);
    await publishDurableState({
      sessionId,
      fromUserId: callerId,
      type: 'leave',
      role: session.host_id === callerId ? 'host' : (caller?.role ?? 'viewer'),
      state: { targetUserId },
    });
    await recordLiveEvent({
      session_id: sessionId,
      event_type: 'participant_removed',
      actor_id: callerId,
      target_user_id: targetUserId,
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('[Live] remove participant failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to remove participant' });
  }
});

/** Leave a live session. */
liveRouter.post('/sessions/:id/leave', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;

    await leaveLiveSession(sessionId, userId);

    await publishDurableState({
      sessionId, fromUserId: userId, type: 'leave', role: 'viewer', state: { targetUserId: userId },
    });
    await recordLiveEvent({
      session_id: sessionId,
      event_type: 'participant_left',
      actor_id: userId,
      target_user_id: userId,
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('[Live] leave session failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to leave session' });
  }
});

/** Raise hand in a live session. */
liveRouter.post('/sessions/:id/participants/:userId/raise-hand', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId, userId: targetUserId } = req.params;

    const session = await getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const { participant: caller } = await authorizeSessionAccess(sessionId, userId);
    const canModerate = session.host_id === userId ||
      caller?.role === 'host' || caller?.role === 'moderator';
    if (targetUserId !== userId && !canModerate) {
      res.status(403).json({ error: 'Only hosts and moderators can raise hands for others' });
      return;
    }

    const participant = await raiseHand(sessionId, targetUserId);
    if (!participant) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }

    await publishDurableState({
      sessionId,
      fromUserId: userId,
      type: 'participant-state',
      role: session.host_id === userId ? 'host' : (caller?.role ?? 'viewer'),
      state: { raisedHand: true, targetUserId },
    });

    res.json(participant);
  } catch (error) {
    console.error('[Live] raise hand failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to raise hand' });
  }
});

/** Lower hand in a live session. */
liveRouter.post('/sessions/:id/participants/:userId/lower-hand', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId, userId: targetUserId } = req.params;

    const session = await getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const { participant: caller } = await authorizeSessionAccess(sessionId, userId);
    const canModerate = session.host_id === userId ||
      caller?.role === 'host' || caller?.role === 'moderator';
    if (targetUserId !== userId && !canModerate) {
      res.status(403).json({ error: 'Only hosts and moderators can lower hands for others' });
      return;
    }

    const participant = await lowerHand(sessionId, targetUserId);
    if (!participant) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }

    await publishDurableState({
      sessionId,
      fromUserId: userId,
      type: 'participant-state',
      role: session.host_id === userId ? 'host' : (caller?.role ?? 'viewer'),
      state: { raisedHand: false, targetUserId },
    });

    res.json(participant);
  } catch (error) {
    console.error('[Live] lower hand failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to lower hand' });
  }
});

// ============================================================================
// Comments
// ============================================================================

/** Send a comment to a live session. */
liveRouter.post('/sessions/:id/comments', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;
    const body = requireBody(req, res, ['content']);
    if (!body) return;

    const comment = await addLiveComment({
      session_id: sessionId,
      user_id: userId,
      content: body.content as string,
    });

    res.status(201).json(comment);
  } catch (error) {
    console.error('[Live] add comment failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to send comment' });
  }
});

/** Get comments for a live session. */
liveRouter.get('/sessions/:id/comments', async (req: Request, res: Response) => {
  try {
    const { id: sessionId } = req.params;
    const limit = Number(req.query.limit) || 50;
    const comments = await getLiveComments(sessionId, limit);
    res.json(comments);
  } catch (error) {
    console.error('[Live] get comments failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

/** Hide a comment (host/moderator only). */
liveRouter.delete('/sessions/:id/comments/:commentId', async (req: Request, res: Response) => {
  try {
    const callerId = req.user!.id;
    const { id: sessionId, commentId } = req.params;

    // Authorize: host or moderator of the session.
    const { participant: callerParticipant } = await authorizeSessionAccess(sessionId, callerId, 'moderator');

    await hideComment(commentId);

    // Comment moderation is a REST concern; clients refresh comments after
    // this call. No WebRTC signaling event is required.
    res.json({ ok: true });
  } catch (error) {
    console.error('[Live] hide comment failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to hide comment' });
  }
});

// ============================================================================
// Live session posts
// ============================================================================

/** Create a live post for a session (frontend calls this when starting a broadcast). */
liveRouter.post('/sessions/:sessionId/posts', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;
    const body = requireBody(req, res, ['title', 'stream_type', 'audience_type']);
    if (!body) return;

    // Verify the session exists and the caller is the host.
    const session = await getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.host_id !== userId) {
      res.status(403).json({ error: 'Only the host can create a live post for this session' });
      return;
    }

    // Idempotency: a reconnect must never create a second LIVE post. Return the
    // existing post for this session if one was already created.
    const existing = await database.query('posts', { live_session_id: sessionId });
    if (existing.length > 0) {
      res.status(200).json({ id: (existing[0] as { id: string }).id, existing: true });
      return;
    }

    // Create the post in the posts table linked to this session.
    const postData = {
      id: crypto.randomUUID(),
      user_id: session.host_id,
      host_id: session.host_id,
      title: body.title ?? null,
      stream_type: body.stream_type,
      status: 'live',
      audience_type: body.audience_type ?? 'public',
      audience_user_ids: body.audience_user_ids ?? null,
      audience_excluded_user_ids: body.audience_excluded_user_ids ?? null,
      audience_list_id: body.audience_list_id ?? null,
      live_session_id: sessionId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result = await database.write('posts', postData);
    const created = (Array.isArray(result) ? result[0] : result) as { id: string };

    res.status(201).json({ id: created.id });
  } catch (error) {
    console.error('[Live] create live post failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to create live post' });
  }
});

// ============================================================================
// Reactions
// ============================================================================

/** Send a reaction to a live session. */
liveRouter.post('/sessions/:id/reactions', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;
    const body = requireBody(req, res, ['reaction_type']);
    if (!body) return;

    const reaction = await addLiveReaction({
      session_id: sessionId,
      user_id: userId,
      reaction_type: body.reaction_type as string,
    });

    res.status(201).json(reaction);
  } catch (error) {
    console.error('[Live] add reaction failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to send reaction' });
  }
});

/** Get reactions for a live session. */
liveRouter.get('/sessions/:id/reactions', async (req: Request, res: Response) => {
  try {
    const { id: sessionId } = req.params;
    const reactions = await getLiveReactions(sessionId);
    res.json(reactions);
  } catch (error) {
    console.error('[Live] get reactions failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to get reactions' });
  }
});

// ============================================================================
// Recordings
// ============================================================================

/** Toggle recording on a live session (host only). */
liveRouter.post('/sessions/:id/recording', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;
    const body = requireBody(req, res, []);
    if (!body) return;

    const session = await getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.host_id !== userId) {
      res.status(403).json({ error: 'Only the host can control recording' });
      return;
    }

    const recording = await addLiveRecording({ session_id: sessionId });
    await updateLiveSession(sessionId, {
      recording: body.recording ?? true,
      recording_url: null,
    } as any);

    res.status(201).json(recording);
  } catch (error) {
    console.error('[Live] recording failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to manage recording' });
  }
});

// ============================================================================
// Reports
// ============================================================================

/** Submit a report for a live session. */
liveRouter.post('/sessions/:id/reports', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;
    const body = requireBody(req, res, ['reason']);
    if (!body) return;

    const report = await submitLiveReport({
      session_id: sessionId,
      reporter_id: userId,
      reported_user_id: body.reported_user_id as string | null | undefined,
      reason: body.reason as string,
      description: body.description as string | null | undefined,
    });

    res.status(201).json(report);
  } catch (error) {
    console.error('[Live] submit report failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// ============================================================================
// Events
// ============================================================================

/** Record a live session event. */
liveRouter.post('/sessions/:id/events', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;
    const body = requireBody(req, res, ['event_type']);
    if (!body) return;

    const event = await recordLiveEvent({
      session_id: sessionId,
      event_type: body.event_type as string,
      actor_id: userId,
      target_user_id: body.target_user_id as string | null | undefined,
      metadata: body.metadata as Record<string, unknown> | null | undefined,
    });

    res.status(201).json(event);
  } catch (error) {
    console.error('[Live] record event failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

// ============================================================================
// Signaling (WebRTC) — durable WebSocket only
// ============================================================================
// The previous SSE subscribe/publish endpoints were removed with the old
// media-server transport.
// Browser media signaling is now carried exclusively by the authenticated
// WebSocket at /api/live/signaling, coordinated through the durable Supabase
// tables created in migration 005.

/**
 * Issue a short-lived, single-use WebSocket signaling ticket.
 *
 * Browsers cannot attach an Authorization header to a WebSocket upgrade, so the
 * client first calls this authenticated HTTP endpoint. The Gateway verifies the
 * user's identity, session access, audience restrictions and role, then returns
 * an opaque ticket. The WebSocket endpoint consumes the ticket exactly once.
 * No long-lived access token or secret is ever placed in a WebSocket URL.
 */
liveRouter.post('/sessions/:id/signaling-ticket', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;

    const session = await getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.status !== 'live' && session.status !== 'scheduled') {
      res.status(409).json({ error: 'Session is not active' });
      return;
    }

    // Audience/privacy enforcement (public, friends, specific, ...).
    try {
      await assertLiveAudienceAccess(session, userId);
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
      return;
    }

    const participants = await getSessionParticipants(sessionId);
    const me = participants.find((p) => p.user_id === userId) ?? null;
    const role = getEffectiveLiveRole(session, userId, me);

    // Viewer/listener cap for the signaling mesh.
    if (session.max_viewers != null && session.host_id !== userId &&
        participants.length >= session.max_viewers) {
      res.status(403).json({ error: 'Session is full' });
      return;
    }

    const issued = await createSignalingTicket({ sessionId, userId, role, ttlSeconds: 60 });
    // The raw ticket is returned once; only its hash is stored server-side.
    res.json({
      ticket: issued.ticket,
      sessionId: issued.sessionId,
      userId: issued.userId,
      role: issued.role,
      expiresAt: issued.expiresAt,
      ttlSeconds: 60,
    });
  } catch (error) {
    console.error('[Live] signaling ticket failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to issue signaling ticket' });
  }
});

export { liveRouter };
