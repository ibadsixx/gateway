-- Migration 003: Ensure a writable project exists for the `conversations` domain
--
-- Root cause of `No writable project for domain: conversations` (messages.md):
-- the conversations host (`project_key = 'convrsation-1'`) exists in
-- `infrastructure_projects` but the row does not satisfy every writable filter
-- that `projectManager.getWritableProject('conversations')` applies
-- (src/project-manager/index.ts:85-96):
--   write_enabled = true  AND  status = 'active'  AND  health_status <> 'offline'
--   AND  (capacity <= 0 OR used_space / capacity < 90%)
-- Reads keep working (getReadableProjects only requires status = 'active'),
-- which is why the app talks to the host but every write rejects.
--
-- This migration heals the EXISTING conversations project row (it does NOT
-- create a new Supabase project and never touches application data). It is
-- idempotent and safe to re-run. Apply it against the infrastructure DB
-- (the Supabase project behind INFRA_SUPABASE_URL/INFRA_SUPABASE_KEY).

-- 1) Make the existing conversations project writable without overwriting the
--    stored URL/service keys or operational capacity/usage metrics.
UPDATE infrastructure_projects
SET write_enabled   = true,
    status          = 'active',
    health_status   = COALESCE(health_status, 'online'),
    updated_at      = now()
WHERE (domain = 'conversations' OR project_key = 'convrsation-1')
  AND (write_enabled IS NOT TRUE OR status <> 'active' OR health_status = 'offline');

-- 2) Point the `domains` routing row for `conversations` at that writable
--    project, but only when the pointer is missing — never clobber an explicit
--    operator choice. (`domains.current_write_project` is the authority the
--    schema comment in 001_create_infrastructure_tables.sql describes.)
INSERT INTO domains (name, current_write_project)
SELECT 'conversations', p.id
FROM infrastructure_projects p
WHERE p.domain = 'conversations'
  AND p.status = 'active'
  AND p.write_enabled IS TRUE
ORDER BY p.priority ASC
LIMIT 1
ON CONFLICT (name) DO NOTHING;

-- 3) Verification: the writable project the gateway will now resolve for the
--    `conversations` domain. No rows = no conversations project exists in this
--    infra DB yet; create one rooted on the live host (project_key
--    'convrsation-1') with its URL/service/anon keys and re-run this migration.
SELECT p.project_key, p.project_url, p.status, p.write_enabled, p.health_status,
       p.capacity, p.used_space
FROM infrastructure_projects p
WHERE p.domain = 'conversations'
   OR p.project_key = 'convrsation-1'
ORDER BY p.priority ASC;