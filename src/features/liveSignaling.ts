import { Response } from 'express';
import { channelHub } from '../realtime/channelHub';

export type SignalingEvent =
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'join'
  | 'leave'
  | 'mute'
  | 'unmute'
  | 'video-off'
  | 'video-on'
  | 'participant-joined'
  | 'participant-left'
  | 'session-ended';

export interface SignalingPayload {
  sessionId: string;
  fromUserId: string;
  toUserId?: string; // undefined = broadcast to all session participants
  type: SignalingEvent;
  sdp?: string;
  candidate?: { sdpMid: string; sdpMLineIndex: number; candidate: string };
  role?: 'host' | 'moderator' | 'guest' | 'viewer';
  streamType?: 'video' | 'audio';
  timestamp: string;
}

/**
 * Signaling channel naming: `live:<sessionId>` is a broadcast channel that all
 * participants of a live session subscribe to. The gateway publishes
 * signaling events (offer, answer, ICE candidates, join/leave, mute, etc.) to
 * it; each participant's SSE connection receives messages addressed to them or
 * broadcast to the whole session.
 *
 * Each user also has a private `user:<userId>` channel for direct messages
 * (e.g. an invite notification).
 */
function signalingChannel(sessionId: string): string {
  return `live:${sessionId}`;
}

function userChannel(userId: string): string {
  return `user:${userId}`;
}

/**
 * Publish a signaling event to the session channel. Returns the number of
 * local SSE connections that received it.
 */
export function publishSignalingEvent(payload: SignalingPayload): number {
  const channel = signalingChannel(payload.sessionId);
  const delivered = channelHub.publish(channel, payload.type, payload);
  // Also notify the target user on their private channel when the message is
  // directed at a specific user (e.g. an offer sent to one guest).
  if (payload.toUserId) {
    channelHub.publish(userChannel(payload.toUserId), 'signaling', payload);
  }
  return delivered;
}

/**
 * Subscribe an SSE response to a session's signaling channel. Used by the
 * live signaling HTTP endpoint so participants can receive realtime WebRTC
 * signaling messages without a persistent WebSocket.
 */
export function subscribeToSessionSignaling(
  sessionId: string,
  userId: string,
  res: Response
): string {
  const channel = signalingChannel(sessionId);
  return channelHub.subscribe(channel, res);
}

/**
 * Subscribe an SSE response to a user's private channel.
 */
export function subscribeToUserSignaling(userId: string, res: Response): string {
  const channel = userChannel(userId);
  return channelHub.subscribe(channel, res);
}

/**
 * Build a signaling payload with the standard fields.
 */
export function makeSignalingPayload(
  sessionId: string,
  fromUserId: string,
  type: SignalingEvent,
  opts: {
    toUserId?: string;
    sdp?: string;
    candidate?: SignalingPayload['candidate'];
    role?: SignalingPayload['role'];
    streamType?: SignalingPayload['streamType'];
  } = {}
): SignalingPayload {
  return {
    sessionId,
    fromUserId,
    toUserId: opts.toUserId,
    type,
    sdp: opts.sdp,
    candidate: opts.candidate,
    role: opts.role,
    streamType: opts.streamType,
    timestamp: new Date().toISOString(),
  };
}
