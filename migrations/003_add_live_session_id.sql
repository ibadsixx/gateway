-- Add live_session_id column to posts table for linking live sessions to posts
ALTER TABLE posts ADD COLUMN IF NOT EXISTS live_session_id TEXT;

-- Add index for efficient lookups by live session
CREATE INDEX IF NOT EXISTS idx_posts_live_session_id ON posts(live_session_id);

-- Add index for efficient lookups of live posts by status
CREATE INDEX IF NOT EXISTS idx_posts_live_session_status ON posts(live_session_id, status);
