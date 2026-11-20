-- Tone Live — PHASE 7 additive repair for production posts.
--
-- The deployed Gateway already writes these fields when creating a LIVE post,
-- but the production posts table does not have them. All three columns are
-- nullable so every existing ordinary post remains valid and unchanged.
-- This migration never drops or recreates posts and never overwrites data.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS host_id TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS live_session_id TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS title TEXT;

-- Justified by the Gateway idempotency lookup:
--   database.query('posts', { live_session_id: sessionId })
-- and by the live-post status query pattern.
CREATE INDEX IF NOT EXISTS idx_posts_live_session_id ON posts(live_session_id);
CREATE INDEX IF NOT EXISTS idx_posts_live_session_status ON posts(live_session_id, status);

-- Foreign keys are deliberately not asserted in this migration. The expected
-- relationships are posts.host_id -> profiles(id) and
-- posts.live_session_id -> live_sessions(id), matching the existing
-- posts.user_id -> profiles(id) relationship and live_sessions.id TEXT.
-- They are omitted until the actual production column types and existing row
-- data have been inspected with authorized SQL access; a guessed FK could
-- either fail on type mismatch or reject valid historical rows. The Gateway
-- already enforces the authenticated host and active session before writing.
