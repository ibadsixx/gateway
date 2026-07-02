-- Infrastructure Database: Gateway Registry
-- This Supabase project stores metadata about all managed infrastructure.
-- It is completely separate from application data databases.

-- ============================================================
-- Table: providers
-- Abstract provider types (e.g., Supabase, Firebase, Cloudinary, AWS S3)
-- ============================================================
CREATE TABLE IF NOT EXISTS providers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL CHECK (type IN ('database', 'storage', 'ai', 'search')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'disabled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Table: infrastructure_projects
-- Each managed database project (application data stores).
-- ============================================================
CREATE TABLE IF NOT EXISTS infrastructure_projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_key     TEXT NOT NULL UNIQUE,          -- e.g. 'posts_1', 'comments_2'
  domain          TEXT NOT NULL,                  -- e.g. 'posts', 'comments', 'stories'
  provider_id     UUID REFERENCES providers(id),
  project_url     TEXT NOT NULL,
  service_key     TEXT NOT NULL,                  -- encrypted at rest
  anon_key        TEXT NOT NULL,                  -- encrypted at rest
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'read_only', 'disabled', 'maintenance')),
  capacity        BIGINT NOT NULL DEFAULT 0,      -- bytes
  used_space      BIGINT NOT NULL DEFAULT 0,      -- bytes
  priority        INT NOT NULL DEFAULT 1,
  load_weight     INT DEFAULT 100,
  region          TEXT,
  response_time   REAL,                          -- latest health check latency (ms)
  last_health_check TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_infra_projects_domain ON infrastructure_projects(domain);
CREATE INDEX idx_infra_projects_status ON infrastructure_projects(status);

-- ============================================================
-- Table: storage_providers
-- Each managed storage account (e.g., Cloudinary, S3, R2 buckets).
-- ============================================================
CREATE TABLE IF NOT EXISTS storage_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key    TEXT NOT NULL UNIQUE,          -- e.g. 'cloudinary_1', 's3_main'
  provider_id     UUID REFERENCES providers(id),
  cloud_name      TEXT NOT NULL,
  api_key         TEXT NOT NULL,                  -- encrypted at rest
  api_secret      TEXT NOT NULL,                  -- encrypted at rest
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'maintenance')),
  capacity        BIGINT NOT NULL DEFAULT 0,      -- bytes
  used_space      BIGINT NOT NULL DEFAULT 0,      -- bytes
  priority        INT NOT NULL DEFAULT 1,
  region          TEXT,
  response_time   REAL,
  last_health_check TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_storage_providers_status ON storage_providers(status);

-- ============================================================
-- Table: domains
-- Routing table: points each domain to its current write project.
-- Instead of scanning all projects on every write, the Gateway
-- reads this pointer and writes directly.
-- ============================================================
CREATE TABLE IF NOT EXISTS domains (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL UNIQUE,
  current_write_project UUID REFERENCES infrastructure_projects(id),
  next_project          UUID REFERENCES infrastructure_projects(id),  -- pre-provisioned for rotation
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_domains_name ON domains(name);

-- ============================================================
-- Table: gateway_settings
-- Dynamic Gateway configuration (replaces hardcoded .env values).
-- ============================================================
CREATE TABLE IF NOT EXISTS gateway_settings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  value       JSONB NOT NULL,
  type        TEXT NOT NULL DEFAULT 'string' CHECK (type IN ('string', 'number', 'boolean', 'json')),
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Table: health_logs
-- Time-series health check records for every managed resource.
-- ============================================================
CREATE TABLE IF NOT EXISTS health_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('database', 'storage', 'service')),
  resource_id   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('online', 'degraded', 'offline')),
  latency_ms    REAL NOT NULL DEFAULT 0,
  usage_pct     REAL NOT NULL DEFAULT 0,
  error_message TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_health_logs_resource ON health_logs(resource_type, resource_id);
CREATE INDEX idx_health_logs_checked ON health_logs(checked_at DESC);

-- ============================================================
-- Default provider entries
-- ============================================================
INSERT INTO providers (name, type, status) VALUES
  ('Supabase', 'database', 'active'),
  ('PostgreSQL', 'database', 'active'),
  ('MongoDB', 'database', 'active'),
  ('Cloudinary', 'storage', 'active'),
  ('AWS S3', 'storage', 'active'),
  ('Cloudflare R2', 'storage', 'active')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- Default gateway settings
-- ============================================================
INSERT INTO gateway_settings (key, value, type, description) VALUES
  ('writeThreshold', '{"value": 90}', 'number', 'Percentage of capacity at which a project is considered full'),
  ('retryCount', '{"value": 3}', 'number', 'Maximum retry attempts for transient failures'),
  ('maxUploadSize', '{"value": 10485760}', 'number', 'Maximum file upload size in bytes'),
  ('healthCheckInterval', '{"value": 60}', 'number', 'Health check interval in seconds'),
  ('softDeleteRetentionDays', '{"value": 30}', 'number', 'Days before soft-deleted data is permanently removed'),
  ('aiModerationEnabled', '{"value": true}', 'boolean', 'Enable AI content moderation')
ON CONFLICT (key) DO NOTHING;
