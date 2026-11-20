// Tone Live — durable, cross-instance signaling coordination.
//
// Vercel WebSocket connections are pinned to one Function instance and instances
// do not share memory. This store is the ONLY place room/signaling coordination
// state lives. It uses the existing Supabase database through the Gateway's
// service-role client. When no Supabase credentials are configured (local unit
// tests and offline development) it falls back to an in-memory implementation
// with identical semantics.
//
// Tables (see migrations/005_create_live_signaling.sql):
//   live_signaling_tickets  — short-lived, single-use connection tickets
//   live_signaling_messages — durable, session-scoped signaling messages

import { createHash, randomBytes } from 'crypto';
import { auth } from '../auth';
import type { ServerSignalingMessage, SignalingEvent } from './liveSignalingProtocol';

export interface SignalingTicket {
  /** Raw secret returned to the client exactly once. Never stored. */
  ticket: string;
  sessionId: string;
  userId: string;
  role: 'host' | 'moderator' | 'guest' | 'viewer';
  expiresAt: string;
}

export interface ConsumedTicket {
  sessionId: string;
  userId: string;
  role: 'host' | 'moderator' | 'guest' | 'viewer';
}

interface TicketRow {
  token_hash: string;
  session_id: string;
  user_id: string;
  role: string;
  expires_at: string;
  consumed_at: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  from_user_id: string;
  to_user_id: string | null;
  type: string;
  role: string;
  sdp: string | null;
  candidate: unknown;
  state: unknown;
  seq: number;
  expires_at: string;
  created_at: string;
}

const DEFAULT_TICKET_TTL_SECONDS = 60;
const DEFAULT_MESSAGE_TTL_SECONDS = 5 * 60;
const MAX_FETCH_LIMIT = 200;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newTicketSecret(): string {
  // 32 bytes of entropy, URL-safe. Only the hash is persisted.
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// In-memory fallback (dev/tests only — never used when Supabase is configured)
// ---------------------------------------------------------------------------
const memTickets = new Map<string, TicketRow>();
const memMessages = new Map<string, MessageRow>();
let memSeq = 0;
let forceMemoryForTests = false;

/** Test-only: force the deterministic in-memory implementation (no network). */
export function useInMemorySignalingForTests(): void {
  forceMemoryForTests = true;
  resetSignalingStoreForTests();
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
// The service-role client is untyped against these Gateway-owned tables.
// Using a loose type here avoids fighting Supabase's generated `never` types
// while all values are still validated by the protocol layer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getClient(): Promise<any | null> {
  if (forceMemoryForTests) return null;
  try {
    return await auth.getSupabaseClient();
  } catch {
    return null;
  }
}

function toConsumed(row: TicketRow): ConsumedTicket {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role as ConsumedTicket['role'],
  };
}

function rowToMessage(row: MessageRow): ServerSignalingMessage {
  const message: ServerSignalingMessage = {
    id: row.id,
    sessionId: row.session_id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id ?? undefined,
    type: row.type as SignalingEvent,
    role: row.role as ServerSignalingMessage['role'],
    seq: row.seq,
    gatewaySeq: row.seq,
    timestamp: row.created_at,
  };
  if (row.sdp) message.sdp = row.sdp;
  if (row.candidate) message.candidate = row.candidate as ServerSignalingMessage['candidate'];
  if (row.state) message.state = row.state as ServerSignalingMessage['state'];
  return message;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Issue a short-lived, single-use ticket for a specific authenticated user and
 * session. The raw ticket is returned once; only its SHA-256 hash is stored.
 */
export async function createSignalingTicket(input: {
  sessionId: string;
  userId: string;
  role: 'host' | 'moderator' | 'guest' | 'viewer';
  ttlSeconds?: number;
}): Promise<SignalingTicket> {
  const ticket = newTicketSecret();
  const tokenHash = sha256(ticket);
  const ttl = Math.max(10, Math.min(input.ttlSeconds ?? DEFAULT_TICKET_TTL_SECONDS, 300));
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const client = await getClient();

  if (client) {
    const { error } = await client.from('live_signaling_tickets').insert({
      token_hash: tokenHash,
      session_id: input.sessionId,
      user_id: input.userId,
      role: input.role,
      expires_at: expiresAt,
      consumed_at: null,
    });
    if (error) throw new Error(`Failed to create signaling ticket: ${error.message}`);
  } else {
    memTickets.set(tokenHash, {
      token_hash: tokenHash,
      session_id: input.sessionId,
      user_id: input.userId,
      role: input.role,
      expires_at: expiresAt,
      consumed_at: null,
    });
  }

  return {
    ticket,
    sessionId: input.sessionId,
    userId: input.userId,
    role: input.role,
    expiresAt,
  };
}

/**
 * Atomically consume a ticket. A conditional UPDATE means only one WebSocket
 * connection in the whole fleet can successfully use a ticket, even when two
 * instances process the same ticket concurrently.
 */
export async function consumeSignalingTicket(
  rawTicket: string,
  expectedSessionId?: string,
): Promise<ConsumedTicket | null> {
  if (typeof rawTicket !== 'string' || rawTicket.length < 20 || rawTicket.length > 256) {
    return null;
  }
  const tokenHash = sha256(rawTicket);
  const now = new Date().toISOString();
  const client = await getClient();

  if (client) {
    let query = client
      .from('live_signaling_tickets')
      .update({ consumed_at: now })
      .eq('token_hash', tokenHash)
      .is('consumed_at', null)
      .gt('expires_at', now);

    if (expectedSessionId) query = query.eq('session_id', expectedSessionId);

    const { data, error } = await query.select('session_id,user_id,role').maybeSingle();
    if (error) {
      console.error('[LiveSignaling] Ticket consume error:', error.message);
      return null;
    }
    return data ? toConsumed(data as unknown as TicketRow) : null;
  }

  const row = memTickets.get(tokenHash);
  if (!row || row.consumed_at || row.expires_at <= now) return null;
  if (expectedSessionId && row.session_id !== expectedSessionId) return null;
  row.consumed_at = now; // atomic in single-threaded Node
  return toConsumed(row);
}

/**
 * Persist a signaling message durably. The client-generated `id` is the primary
 * key, making delivery idempotent: a retry of the same message is a no-op.
 */
export async function storeSignalingMessage(message: {
  id: string;
  sessionId: string;
  fromUserId: string;
  toUserId?: string;
  type: SignalingEvent;
  role: 'host' | 'moderator' | 'guest' | 'viewer';
  sdp?: string;
  candidate?: unknown;
  state?: unknown;
  seq?: number;
  ttlSeconds?: number;
}): Promise<{ seq: number; duplicate: boolean }> {
  const now = new Date();
  const ttl = Math.max(30, Math.min(message.ttlSeconds ?? DEFAULT_MESSAGE_TTL_SECONDS, 900));
  const client = await getClient();

  if (client) {
    // The cursor MUST be globally unique and monotonic across Gateway
    // instances. Local clocks can collide, so we reserve it from a real
    // Postgres sequence exposed through an RPC in migration 005.
    const { data: seqData, error: seqError } = await client.rpc('next_live_signaling_message_seq');
    if (seqError || seqData == null) {
      throw new Error(`Failed to reserve signaling seq: ${seqError?.message ?? 'no value returned'}`);
    }
    const seq = Number(seqData);
    const row: MessageRow = {
      id: message.id,
      session_id: message.sessionId,
      from_user_id: message.fromUserId,
      to_user_id: message.toUserId ?? null,
      type: message.type,
      role: message.role,
      sdp: message.sdp ?? null,
      candidate: message.candidate ?? null,
      state: message.state ?? null,
      seq,
      expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
      created_at: now.toISOString(),
    };
    const { data, error } = await client
      .from('live_signaling_messages')
      .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
      .select('seq')
      .maybeSingle();
    if (error) throw new Error(`Failed to store signaling message: ${error.message}`);
    // ignoreDuplicates returns no row for an existing id.
    return { seq: data ? Number((data as { seq: number }).seq) : seq, duplicate: !data };
  }

  if (memMessages.has(message.id)) {
    return { seq: memMessages.get(message.id)!.seq, duplicate: true };
  }
  const seq = ++memSeq;
  memMessages.set(message.id, {
    id: message.id,
    session_id: message.sessionId,
    from_user_id: message.fromUserId,
    to_user_id: message.toUserId ?? null,
    type: message.type,
    role: message.role,
    sdp: message.sdp ?? null,
    candidate: message.candidate ?? null,
    state: message.state ?? null,
    seq,
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    created_at: now.toISOString(),
  });
  return { seq, duplicate: false };
}

/**
 * Fetch pending messages for one recipient. Returns broadcast messages plus
 * messages addressed directly to `recipientUserId`, ordered by seq, bounded by
 * `limit`. The `afterSeq` cursor supports reconnect/resubscription without
 * replaying already-delivered messages.
 */
export async function fetchSignalingMessages(input: {
  sessionId: string;
  recipientUserId: string;
  afterSeq?: number;
  limit?: number;
}): Promise<ServerSignalingMessage[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, MAX_FETCH_LIMIT));
  const afterSeq = input.afterSeq ?? 0;
  const now = new Date().toISOString();
  const client = await getClient();

  if (client) {
    // Build two independent query objects: Supabase query builders are mutable,
    // so reusing one builder for both branches would accumulate filters.
    const buildQuery = () => client
      .from('live_signaling_messages')
      .select('*')
      .eq('session_id', input.sessionId)
      .gt('seq', afterSeq)
      .gt('expires_at', now)
      .order('seq', { ascending: true })
      .limit(limit);

    const [broadcastRes, directedRes] = await Promise.all([
      buildQuery().is('to_user_id', null),
      buildQuery().eq('to_user_id', input.recipientUserId),
    ]);

    if (broadcastRes.error) console.error('[LiveSignaling] Fetch broadcast error:', broadcastRes.error.message);
    if (directedRes.error) console.error('[LiveSignaling] Fetch directed error:', directedRes.error.message);

    const rows = [
      ...((broadcastRes.data ?? []) as unknown as MessageRow[]),
      ...((directedRes.data ?? []) as unknown as MessageRow[]),
    ];
    rows.sort((a, b) => a.seq - b.seq);
    return rows.slice(0, limit).map(rowToMessage);
  }

  return Array.from(memMessages.values())
    .filter((row) =>
      row.session_id === input.sessionId &&
      row.seq > afterSeq &&
      row.expires_at > now &&
      (row.to_user_id === null || row.to_user_id === input.recipientUserId))
    .sort((a, b) => a.seq - b.seq)
    .slice(0, limit)
    .map(rowToMessage);
}

/** Delete expired signaling rows. Safe to call periodically; bounded by TTL. */
export async function cleanupExpiredSignaling(): Promise<void> {
  const now = new Date().toISOString();
  const client = await getClient();
  if (client) {
    await client.from('live_signaling_tickets').delete().lt('expires_at', now);
    await client.from('live_signaling_messages').delete().lt('expires_at', now);
    return;
  }
  for (const [key, row] of memTickets) if (row.expires_at <= now) memTickets.delete(key);
  for (const [key, row] of memMessages) if (row.expires_at <= now) memMessages.delete(key);
}

/** Test-only helper: clear in-memory fallback state. */
export function resetSignalingStoreForTests(): void {
  memTickets.clear();
  memMessages.clear();
  memSeq = 0;
}

/** Test-only helper: force a ticket into the past to exercise expiry. */
export function expireSignalingTicketForTests(rawTicket: string): void {
  const row = memTickets.get(sha256(rawTicket));
  if (row) row.expires_at = new Date(Date.now() - 1000).toISOString();
}
