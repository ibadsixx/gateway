-- Tone Live — PHASE 4 durable P2P signaling coordination.
--
-- Vercel WebSocket connections are pinned to individual Function instances and
-- instances do not share in-memory state. These two tables are the ONLY shared
-- coordination state for live signaling. They are accessed exclusively through
-- the Gateway (service role), never by browser clients directly.
--
-- This migration is additive and idempotent. It creates no duplicate of any
-- existing live_sessions / live_participants / live_events table.

-- ---------------------------------------------------------------------------
-- 1. Short-lived, single-use WebSocket connection tickets.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_signaling_tickets (
  token_hash   TEXT PRIMARY KEY,              -- SHA-256 of the raw ticket; raw ticket is never stored
  session_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('host', 'moderator', 'guest', 'viewer')),
  expires_at   TIMESTAMP WITH TIME ZONE NOT NULL,
  consumed_at  TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fast lookup of a ticket by session (audit / cleanup) and cleanup of old rows.
CREATE INDEX IF NOT EXISTS idx_live_signaling_tickets_session
  ON live_signaling_tickets(session_id);
CREATE INDEX IF NOT EXISTS idx_live_signaling_tickets_expires
  ON live_signaling_tickets(expires_at);
CREATE INDEX IF NOT EXISTS idx_live_signaling_tickets_unconsumed
  ON live_signaling_tickets(consumed_at) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Durable, session-scoped signaling messages.
-- ---------------------------------------------------------------------------
-- A real Postgres sequence is required for the cursor: multiple Gateway
-- instances must never derive the same seq from their local clocks. The
-- Gateway calls this function through the service role.
CREATE SEQUENCE IF NOT EXISTS live_signaling_message_seq AS BIGINT;
CREATE OR REPLACE FUNCTION next_live_signaling_message_seq()
RETURNS BIGINT
LANGUAGE sql
VOLATILE
AS $$
  SELECT nextval('live_signaling_message_seq');
$$;

CREATE TABLE IF NOT EXISTS live_signaling_messages (
  id            TEXT PRIMARY KEY,             -- client-generated UUID => idempotent delivery
  seq           BIGINT UNIQUE NOT NULL,       -- Gateway-assigned monotonic cursor for bounded fetches
  session_id    TEXT NOT NULL,
  from_user_id  TEXT NOT NULL,                -- Gateway-derived from the ticket (never client input)
  to_user_id    TEXT,                         -- NULL = broadcast to all session participants
  type          TEXT NOT NULL,
  role          TEXT NOT NULL,
  sdp           TEXT,
  candidate     JSONB,
  state         JSONB,
  expires_at    TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Session-scoped routing with cursor pagination (the hot query path).
CREATE INDEX IF NOT EXISTS idx_live_signaling_messages_session_seq
  ON live_signaling_messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_live_signaling_messages_recipient
  ON live_signaling_messages(session_id, to_user_id, seq);
CREATE INDEX IF NOT EXISTS idx_live_signaling_messages_expires
  ON live_signaling_messages(expires_at);

-- NOTE: RLS is intentionally NOT enabled for these tables. They are reachable
-- only through the Gateway service role; browser clients have no table access.
-- The Gateway enforces authentication, audience, role, payload schema, message
-- size, rate limits, idempotency and expiry in application code.
