// Tone Live — Docker-side authenticated P2P signaling WebSocket attachment.
//
// This mirrors api/live/signaling.ts so the existing Vercel deployment remains
// untouched while the Docker custom server (src/dockerServer.ts) exposes the
// same endpoint with the same ticket authentication, validation, rate limits
// and durable message recovery. Keep the two files in sync if signaling rules
// change. All routing/presence state remains durable in liveSignalingStore
// (Supabase through the Gateway); only per-connection cursors and rate-limit
// counters are local.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  consumeSignalingTicket,
  fetchSignalingMessages,
  storeSignalingMessage,
  cleanupExpiredSignaling,
} from './liveSignalingStore';
import {
  validateClientSignalingMessage,
  SignalingRateLimiter,
  MAX_SIGNALING_MESSAGE_BYTES,
  type ServerSignalingMessage,
} from './liveSignalingProtocol';
import {
  getLiveSession,
  getSessionParticipants,
  getEffectiveLiveRole,
  assertLiveAudienceAccess,
} from './liveSessions';

const POLL_INTERVAL_MS = 400;
const MAX_POLLS = 600; // 600 * 400ms = 240s, under the 300s Function maxDuration
const HEARTBEAT_MS = 20_000;
const CLEANUP_INTERVAL_MS = 60_000;
const MAX_MESSAGES_PER_POLL = 50;

let lastCleanupAt = 0;

export function attachLiveSignaling(server: http.Server): WebSocketServer {
  // The Vercel Function receives only /api/live/signaling. The Docker custom
  // server receives every path, so enforce the same endpoint explicitly here.
  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_SIGNALING_MESSAGE_BYTES,
    perMessageDeflate: false,
    verifyClient: (info, done) => {
      let pathname = '';
      try {
        pathname = new URL(info.req.url ?? '/', 'http://localhost').pathname;
      } catch {
        // Invalid request targets are rejected below.
      }
      if (pathname === '/api/live/signaling') {
        done(true);
      } else {
        done(false, 404, 'Not Found');
      }
    },
  });

  function closeWith(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      try { ws.terminate(); } catch { /* already gone */ }
    }
  }

  function sendJson(ws: WebSocket, value: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(value));
    } catch (error) {
      console.error('[LiveSignaling] send failed:', (error as Error).message);
    }
  }

  function serverMessage(input: {
    id: string;
    sessionId: string;
    fromUserId: string;
    toUserId?: string;
    type: ServerSignalingMessage['type'];
    role: ServerSignalingMessage['role'];
    sdp?: string;
    candidate?: ServerSignalingMessage['candidate'];
    state?: ServerSignalingMessage['state'];
    seq?: number;
  }): ServerSignalingMessage {
    return { ...input, gatewaySeq: input.seq, timestamp: new Date().toISOString() };
  }

  wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let cleanupTimer: ReturnType<typeof setInterval> | null = null;
    let polling = false;
    let connectionContext: { sessionId: string; userId: string; role: ServerSignalingMessage['role'] } | null = null;

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rawTicket = url.searchParams.get('ticket') ?? '';
      const afterParam = Number(url.searchParams.get('after') ?? '0');
      let cursor = Number.isFinite(afterParam) && afterParam > 0 ? Math.floor(afterParam) : 0;

      if (!rawTicket) {
        closeWith(ws, 4001, 'missing_ticket');
        return;
      }

      // Atomic, single-use ticket consumption: one DELETE ... RETURNING in the
      // Gateway, no custom Supabase function.
      const ticket = await consumeSignalingTicket(rawTicket);
      if (!ticket) {
        closeWith(ws, 4002, 'invalid_or_used_ticket');
        return;
      }

      // Re-verify session, audience and role from server-side state.
      const session = await getLiveSession(ticket.sessionId);
      if (!session) {
        closeWith(ws, 4004, 'session_not_found');
        return;
      }
      if (session.status !== 'live' && session.status !== 'scheduled') {
        closeWith(ws, 4005, 'session_not_active');
        return;
      }
      try {
        await assertLiveAudienceAccess(session, ticket.userId);
      } catch {
        closeWith(ws, 4006, 'audience_denied');
        return;
      }

      const participants = await getSessionParticipants(ticket.sessionId);
      const me = participants.find((p) => p.user_id === ticket.userId) ?? null;
      const role = getEffectiveLiveRole(session, ticket.userId, me);
      connectionContext = { sessionId: ticket.sessionId, userId: ticket.userId, role };
      const limiter = new SignalingRateLimiter();

      // Acknowledge the connection and provide the durable delivery cursor.
      sendJson(ws, serverMessage({
        id: randomUUID(),
        sessionId: ticket.sessionId,
        fromUserId: 'gateway',
        type: 'connected',
        role,
        seq: cursor,
      }));

      // Announce the join to all existing peers so they can create offers to us.
      // The newcomer never offers on join; existing peers initiate, which avoids
      // duplicate/glare offers. Perfect negotiation in the client is a backstop.
      await storeSignalingMessage({
        id: randomUUID(),
        sessionId: ticket.sessionId,
        fromUserId: ticket.userId,
        type: 'join',
        role,
        ttlSeconds: 30,
      });

      // Bounded polling: fetch messages addressed to this user (or broadcast)
      // from durable storage, using the cursor so reconnects resume cleanly.
      pollTimer = setInterval(async () => {
        if (polling || ws.readyState !== WebSocket.OPEN) return;
        polling = true;
        try {
          const messages = await fetchSignalingMessages({
            sessionId: ticket.sessionId,
            recipientUserId: ticket.userId,
            afterSeq: cursor,
            limit: MAX_MESSAGES_PER_POLL,
          });
          for (const message of messages) {
            if (message.gatewaySeq && message.gatewaySeq > cursor) cursor = message.gatewaySeq;
            sendJson(ws, message);
          }
        } catch (error) {
          console.error('[LiveSignaling] poll error:', (error as Error).message);
        } finally {
          polling = false;
        }
      }, POLL_INTERVAL_MS);

      // Heartbeat detects dead sockets early.
      heartbeatTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.ping();
      }, HEARTBEAT_MS);
      ws.on('pong', () => { /* connection alive */ });

      // Periodic, bounded cleanup of expired rows.
      if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
        lastCleanupAt = Date.now();
        cleanupExpiredSignaling().catch((error) => {
          console.error('[LiveSignaling] cleanup error:', (error as Error).message);
        });
      }
      cleanupTimer = setInterval(() => {
        cleanupExpiredSignaling().catch((error) => {
          console.error('[LiveSignaling] cleanup error:', (error as Error).message);
        });
      }, CLEANUP_INTERVAL_MS);

      let polls = 0;
      const maxPollTimer = setInterval(() => {
        polls++;
        if (polls >= MAX_POLLS) {
          // Vercel Functions are not immortal. Close cleanly so the client
          // reconnects with a fresh ticket and restores state from the cursor.
          closeWith(ws, 4000, 'function_rotation');
          clearInterval(maxPollTimer);
        }
      }, POLL_INTERVAL_MS);
      ws.on('close', () => clearInterval(maxPollTimer));

      ws.on('message', async (raw: RawData) => {
        // `ws` delivers Buffer, ArrayBuffer, or Buffer[]. Normalize before the
        // protocol validator so every frame is handled consistently.
        let frame: Buffer | ArrayBuffer;
        if (Array.isArray(raw)) {
          frame = Buffer.concat(raw);
        } else if (raw instanceof ArrayBuffer) {
          frame = raw;
        } else {
          frame = raw as Buffer;
        }

        const validated = validateClientSignalingMessage(frame);
        if (!validated.ok) {
          sendJson(ws, {
            type: 'error',
            code: validated.error,
            sessionId: ticket.sessionId,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (!limiter.allow()) {
          sendJson(ws, { type: 'error', code: 'rate_limited', timestamp: new Date().toISOString() });
          return;
        }

        const message = validated.message;
        if (message.sessionId !== ticket.sessionId) {
          sendJson(ws, { type: 'error', code: 'session_mismatch', timestamp: new Date().toISOString() });
          return;
        }
        // A recipient must be an actual participant of this session.
        if (message.toUserId && !participants.some((p) => p.user_id === message.toUserId)) {
          // Participants may join after our snapshot; allow directed messages but
          // they will simply not be delivered if the user is not present.
        }

        try {
          await storeSignalingMessage({
            id: message.id,
            sessionId: ticket.sessionId,
            fromUserId: ticket.userId, // authoritative — never accept client-supplied sender
            toUserId: message.toUserId,
            type: message.type,
            role,
            sdp: message.sdp,
            candidate: message.candidate,
            state: message.state,
          });
        } catch (error) {
          console.error('[LiveSignaling] store error:', (error as Error).message);
          sendJson(ws, { type: 'error', code: 'store_failed', timestamp: new Date().toISOString() });
        }
      });
    } catch (error) {
      console.error('[LiveSignaling] connection setup failed:', (error as Error).message);
      closeWith(ws, 4500, 'setup_failed');
    }

    ws.on('close', (code: number) => {
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);

      // A deliberate client disconnect / tab close means the peer is gone.
      // Function rotation (4000) is NOT a leave: the client reconnects with the
      // same participant identity and must keep its peer connections.
      if (connectionContext && (code === 1000 || code === 1001)) {
        storeSignalingMessage({
          id: randomUUID(),
          sessionId: connectionContext.sessionId,
          fromUserId: connectionContext.userId,
          type: 'leave',
          role: connectionContext.role,
          ttlSeconds: 30,
        }).catch((error) => {
          console.error('[LiveSignaling] leave publish failed:', (error as Error).message);
        });
      }
    });
    ws.on('error', (error) => {
      console.error('[LiveSignaling] socket error:', error.message);
    });
  });

  return wss;
}
