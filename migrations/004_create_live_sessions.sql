-- Create live_sessions table for Tone Live feature
CREATE TABLE IF NOT EXISTS live_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  host_id TEXT NOT NULL,
  title TEXT,
  description TEXT,
  stream_type TEXT NOT NULL DEFAULT 'video' CHECK (stream_type IN ('video', 'audio')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended')),
  audience_type TEXT NOT NULL DEFAULT 'public',
  audience_user_ids TEXT[],
  audience_excluded_user_ids TEXT[],
  audience_list_id TEXT,
  recording BOOLEAN DEFAULT FALSE,
  recording_url TEXT,
  viewer_count INTEGER DEFAULT 0,
  max_viewers INTEGER,
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_sessions_host_id ON live_sessions(host_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON live_sessions(status);
CREATE INDEX IF NOT EXISTS idx_live_sessions_created_at ON live_sessions(created_at DESC);
