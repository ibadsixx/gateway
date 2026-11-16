import { Router, Request, Response } from 'express';
import { auth } from '../auth';
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
  authorizeSessionAccess,
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
import {
  subscribeToSessionSignaling,
  subscribeToUserSignaling,
  publishSignalingEvent,
  makeSignalingPayload,
  type SignalingPayload,
  type SignalingEvent,
} from '../features/liveSignaling';

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

    // Broadcast session-ended to all participants.
    const payload = makeSignalingPayload(id, userId, 'session-ended');
    publishSignalingEvent(payload);
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

    // Check audience access
    if (session.audience_type === 'friends' && session.host_id !== userId) {
      res.status(403).json({ error: 'Friends-only session' });
      return;
    }

    const role = (body.role as LiveParticipantRole) ?? 'viewer';
    const participant = await addLiveParticipant({
      session_id: sessionId,
      user_id: userId,
      role,
    });

    // Broadcast participant-joined to the session.
    const payload = makeSignalingPayload(sessionId, userId, 'participant-joined', {
      role,
      streamType: session.stream_type,
    });
    publishSignalingEvent(payload);
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

    // Broadcast the change to the session.
    const payload = makeSignalingPayload(sessionId, callerId, 'participant-updated', {
      toUserId: userId,
      role: participant.role,
    });
    publishSignalingEvent(payload);

    res.json(participant);
  } catch (error) {
    console.error('[Live] update participant failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to update participant' });
  }
});

/** Leave a live session. */
liveRouter.post('/sessions/:id/leave', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;

    await leaveLiveSession(sessionId, userId);

    const payload = makeSignalingPayload(sessionId, userId, 'participant-left');
    publishSignalingEvent(payload);
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

    // Broadcast the hide to the session.
    const payload = makeSignalingPayload(sessionId, callerId, 'comment-hidden', {
      toUserId: undefined,
    });
    publishSignalingEvent(payload);

    res.json({ ok: true });
  } catch (error) {
    console.error('[Live] hide comment failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to hide comment' });
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
// Signaling (WebRTC) - SSE-based
// ============================================================================

/** Subscribe to a live session's signaling channel (SSE). */
liveRouter.get('/sessions/:id/signaling', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;

    const session = await getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Audience enforcement for signaling (same as session access).
    if (session.audience_type === 'friends' && session.host_id !== userId) {
      res.status(403).json({ error: 'Access denied: friends-only session' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const connId = subscribeToSessionSignaling(sessionId, userId, res);
    res.write(`event: init\ndata: ${JSON.stringify({ connId, sessionId, userId })}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
    });
  } catch (error) {
    console.error('[Live] signaling subscribe failed:', (error as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to subscribe to signaling' });
    }
  }
});

/** Subscribe to a user's private signaling channel (SSE). */
liveRouter.get('/users/:userId/signaling', async (req: Request, res: Response) => {
  try {
    const callerId = req.user!.id;
    const { userId } = req.params;

    // Users can only subscribe to their own private signaling channel.
    if (userId !== callerId) {
      res.status(403).json({ error: 'You may only subscribe to your own channel' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const connId = subscribeToUserSignaling(userId, res);
    res.write(`event: init\ndata: ${JSON.stringify({ connId, userId })}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
    });
  } catch (error) {
    console.error('[Live] user signaling subscribe failed:', (error as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to subscribe to user signaling' });
    }
  }
});

/** Publish a signaling event to a session (offer/answer/ICE candidate). */
liveRouter.post('/sessions/:id/signaling', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id: sessionId } = req.params;
    const body = requireBody(req, res, ['type']);
    if (!body) return;

    const session = await getLiveSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const payload = makeSignalingPayload(sessionId, userId, body.type as SignalingEvent, {
      toUserId: body.toUserId as string | undefined,
      sdp: body.sdp as string | undefined,
      candidate: body.candidate as any,
      role: body.role as any,
      streamType: body.streamType as any,
    });

    const delivered = publishSignalingEvent(payload);

    res.json({ ok: true, delivered });
  } catch (error) {
    console.error('[Live] publish signaling failed:', (error as Error).message);
    res.status(500).json({ error: 'Failed to publish signaling event' });
  }
});

export { liveRouter };
