// Tone Live — P2P signaling wire protocol.
//
// This module defines the ONLY messages accepted on the authenticated live
// signaling WebSocket. It is shared by the Gateway WebSocket function and the
// Express ticket endpoint so validation rules never drift between them.
//
// Security notes:
//   - `fromUserId` is NEVER read from a client message. The Gateway derives it
//     from the single-use connection ticket.
//   - Every message is size-limited before JSON parsing of its payload fields.
//   - Only known event types are accepted.

export const MAX_SIGNALING_MESSAGE_BYTES = 128 * 1024; // 128 KiB hard frame cap
export const MAX_SDP_BYTES = 64 * 1024; // 64 KiB SDP cap
export const MAX_CANDIDATE_BYTES = 8 * 1024; // 8 KiB ICE candidate cap
export const MAX_MESSAGES_PER_WINDOW = 120; // per connection, per 10s window
export const RATE_LIMIT_WINDOW_MS = 10_000;

/** Events clients are allowed to publish over the signaling socket. */
export const CLIENT_SIGNALING_EVENTS = [
  'offer',
  'answer',
  'ice-candidate',
  'renegotiate',
  'ice-restart',
  'leave',
  'participant-state',
] as const;

/** Events the Gateway may publish to clients (superset of client events). */
export const SIGNALING_EVENTS = [
  ...CLIENT_SIGNALING_EVENTS,
  'join',
  'joined',
  'participant-joined',
  'participant-left',
  'participant-updated',
  'participant-raised-hand',
  'participant-lowered-hand',
  'session-ended',
  'connected',
  'error',
] as const;

export type ClientSignalingEvent = (typeof CLIENT_SIGNALING_EVENTS)[number];
export type SignalingEvent = (typeof SIGNALING_EVENTS)[number];

export interface IceCandidatePayload {
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  candidate: string;
  usernameFragment?: string | null;
}

export interface ParticipantStatePayload {
  isMuted?: boolean;
  isVideoOff?: boolean;
  raisedHand?: boolean;
  role?: 'host' | 'moderator' | 'guest' | 'viewer';
  /** When a moderator changes another participant's state. */
  targetUserId?: string;
}

export interface ClientSignalingMessage {
  /** Client-generated durable id; used for idempotent delivery. */
  id: string;
  /** Session the message belongs to; must match the ticket's session. */
  sessionId: string;
  type: ClientSignalingEvent;
  /** Optional recipient. Omitted/undefined = broadcast to all peers in session. */
  toUserId?: string;
  /** Monotonic-ish lamport clock from sender, used only for ordering hints. */
  seq?: number;
  sdp?: string;
  candidate?: IceCandidatePayload;
  state?: ParticipantStatePayload;
}

export interface ServerSignalingMessage {
  /** Client-generated durable id (used for idempotent delivery). */
  id: string;
  sessionId: string;
  /** Gateway-derived sender. Clients cannot spoof this. */
  fromUserId: string;
  toUserId?: string;
  type: SignalingEvent;
  /** Gateway-assigned role of the sender at message time. */
  role: 'host' | 'moderator' | 'guest' | 'viewer';
  seq?: number;
  sdp?: string;
  candidate?: IceCandidatePayload;
  state?: ParticipantStatePayload;
  /** Gateway-assigned monotonic sequence for cursor-based delivery. */
  gatewaySeq?: number;
  timestamp: string;
}

export type ValidationResult =
  | { ok: true; message: ClientSignalingMessage }
  | { ok: false; error: string };

const CLIENT_EVENT_SET = new Set<string>(CLIENT_SIGNALING_EVENTS);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize a raw WebSocket frame. Returns a rejected result for
 * malformed, oversized, or unauthorized-shape messages. The `fromUserId` field
 * is stripped if a client attempts to supply it.
 */
export function validateClientSignalingMessage(raw: string | Buffer | ArrayBuffer): ValidationResult {
  const text = typeof raw === 'string'
    ? raw
    : Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : Buffer.from(raw).toString('utf8');

  if (Buffer.byteLength(text, 'utf8') > MAX_SIGNALING_MESSAGE_BYTES) {
    return { ok: false, error: 'message_too_large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }

  if (!isObject(parsed)) {
    return { ok: false, error: 'invalid_shape' };
  }

  const { id, sessionId, type, toUserId, sdp, candidate, state, seq } = parsed;

  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    return { ok: false, error: 'invalid_id' };
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
    return { ok: false, error: 'invalid_session_id' };
  }
  if (typeof type !== 'string' || !CLIENT_EVENT_SET.has(type)) {
    return { ok: false, error: 'invalid_event_type' };
  }
  if (toUserId !== undefined && (typeof toUserId !== 'string' || toUserId.length === 0 || toUserId.length > 128)) {
    return { ok: false, error: 'invalid_recipient' };
  }
  if (seq !== undefined && (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0)) {
    return { ok: false, error: 'invalid_seq' };
  }

  const message: ClientSignalingMessage = {
    id,
    sessionId,
    type: type as ClientSignalingEvent,
  };
  if (toUserId !== undefined) message.toUserId = toUserId;
  if (seq !== undefined) message.seq = seq;

  if (sdp !== undefined) {
    if (type !== 'offer' && type !== 'answer' && type !== 'renegotiate') {
      return { ok: false, error: 'unexpected_sdp' };
    }
    if (typeof sdp !== 'string' || sdp.length === 0 || Buffer.byteLength(sdp, 'utf8') > MAX_SDP_BYTES) {
      return { ok: false, error: 'invalid_sdp' };
    }
    message.sdp = sdp;
  }

  if (candidate !== undefined) {
    if (type !== 'ice-candidate') {
      return { ok: false, error: 'unexpected_candidate' };
    }
    if (!isObject(candidate) || typeof candidate.candidate !== 'string' ||
        Buffer.byteLength(candidate.candidate, 'utf8') > MAX_CANDIDATE_BYTES) {
      return { ok: false, error: 'invalid_candidate' };
    }
    message.candidate = {
      sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid : null,
      sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : null,
      candidate: candidate.candidate,
      usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment : null,
    };
  }

  if (state !== undefined) {
    if (type !== 'participant-state') {
      return { ok: false, error: 'unexpected_state' };
    }
    if (!isObject(state)) {
      return { ok: false, error: 'invalid_state' };
    }
    const clean: ParticipantStatePayload = {};
    for (const key of ['isMuted', 'isVideoOff', 'raisedHand'] as const) {
      if (typeof state[key] === 'boolean') clean[key] = state[key] as boolean;
    }
    if (typeof state.role === 'string' &&
        ['host', 'moderator', 'guest', 'viewer'].includes(state.role)) {
      clean.role = state.role as ParticipantStatePayload['role'];
    }
    if (typeof state.targetUserId === 'string' && state.targetUserId.length <= 128) {
      clean.targetUserId = state.targetUserId;
    }
    message.state = clean;
  }

  return { ok: true, message };
}

/**
 * Sliding-window rate limiter. One instance per connection; no global state,
 * so it works across independent Gateway Function instances.
 */
export class SignalingRateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly limit: number = MAX_MESSAGES_PER_WINDOW,
    private readonly windowMs: number = RATE_LIMIT_WINDOW_MS,
  ) {}

  allow(now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps = [];
  }
}

/** Structural check used for the ticket endpoint's request body. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
