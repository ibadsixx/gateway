-- Infrastructure Database: Gateway Registry
-- Mirrors infrastructure_projects for managed storage resources,
-- redesigned to describe cloud storage accounts (e.g., Cloudinary).

-- ============================================================
-- Table: infrastructure_storage
-- Each managed cloud storage account / bucket.
-- ============================================================
CREATE TABLE IF NOT EXISTS infrastructure_storage (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key        TEXT NOT NULL UNIQUE,          -- e.g. 'cloudinary_1', 's3_main'
  provider_id        UUID REFERENCES providers(id),
  cloud_name         TEXT NOT NULL,                  -- Cloudinary cloud name
  api_key            TEXT NOT NULL,                  -- encrypted at rest
  api_secret         TEXT NOT NULL,                  -- encrypted at rest
  status             TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'full')),
  capacity           BIGINT NOT NULL DEFAULT 0,      -- total storage capacity (bytes)
  used_space         BIGINT NOT NULL DEFAULT 0,      -- used storage (bytes)
  available_space    BIGINT GENERATED ALWAYS AS (capacity - used_space) STORED,  -- remaining (bytes)
  last_update        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- last usage/capacity refresh
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_infra_storage_status ON infrastructure_storage(status);
