-- Migration 002: Add health_status to infrastructure_projects
-- This enables the RoutingService to filter by health status
-- when selecting the writable project for a domain.

ALTER TABLE infrastructure_projects
  ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'online'
  CHECK (health_status IN ('online', 'degraded', 'offline'));

-- Set all existing active projects to 'online' by default
UPDATE infrastructure_projects
  SET health_status = 'online'
  WHERE health_status IS NULL;
