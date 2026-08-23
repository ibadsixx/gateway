-- Keep-alive scheduler state — persisted per-project probe schedule.
-- Complements `infrastructure_projects`: the scheduler reads the registry,
-- then claims due projects here so probes are spread evenly across the day
-- (KEEP_ALIVE_CHECKS_PER_DAY per project, default 10 → one every ~2h 24m)
-- instead of firing as a single daily burst. Survives serverless cold starts.

-- ============================================================
-- Table: keep_alive_state
-- One row per registered backend project.
-- ============================================================
CREATE TABLE IF NOT EXISTS keep_alive_state (
  project_key         TEXT PRIMARY KEY REFERENCES infrastructure_projects(project_key) ON DELETE CASCADE,
  project_name        TEXT NOT NULL,                    -- denormalized display name (project_key at write time)
  last_keepalive_at   TIMESTAMPTZ,                      -- last probe actually sent
  next_keepalive_at   TIMESTAMPTZ NOT NULL DEFAULT now(), -- claim stamp: probes run when now() >= this
  keepalive_count_24h INT NOT NULL DEFAULT 0,           -- probes in the trailing 24h window
  count_window_start  TIMESTAMPTZ NOT NULL DEFAULT now(), -- start of the current rolling window
  health_status       TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('online', 'degraded', 'offline', 'unknown')),
  consecutive_failures INT NOT NULL DEFAULT 0,
  latency_ms          REAL,
  last_error          TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_keep_alive_state_due ON keep_alive_state(next_keepalive_at);
