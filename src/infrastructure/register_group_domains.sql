-- ============================================================================
-- Deployment-time registry configuration for the Group moderation tables
-- ----------------------------------------------------------------------------
-- RUN THIS AGAINST THE **INFRASTRUCTURE** DATABASE (the Supabase project that
-- owns `infrastructure_projects`) — NOT against groups-1 or any app project.
--
-- This is deployment-time configuration, not migration code. It is deliberately
-- written as INSERT ... SELECT from the already-registered `groups` row so that
-- project_url / service_key / anon_key / provider_id / capacity / write_enabled
-- / health_status are COPIED FROM VERIFIED PRODUCTION VALUES. No project id or
-- URL is invented here.
--
-- PREREQUISITE (same foot-gun class as the group_image / message_requests gaps):
-- The hosting project must already contain the tables. The style migrations are:
--   tone-your-social-voice/supabase/migrations/
--     20260917000000_add_group_rules.sql
--     20260918000000_group_member_moderation.sql
-- Their foreign keys reference public.groups(id), public.profiles(id) and
-- public.group_rules(id), so they must be applied to ONE project that already
-- hosts groups + profiles + group_rules. The intended project is the one whose
-- infrastructure_projects row has domain='groups' (groups-1). If that project
-- does not contain `profiles`, applying the 20260918 migration there will fail —
-- in that case choose the project that has groups + profiles + group_rules and
-- change the source domain in the CTE below to that project's row.
--
-- After this runs: cold-start Vercel instances will pick the new domains up on
-- next deploy/instance recycle (feature flags enable at cold start).
-- ============================================================================

BEGIN;

-- 1) Clone the hosting project row once per group domain.
WITH source AS (
  SELECT provider_id, project_url, service_key, anon_key, status,
         capacity, used_space, priority, load_weight,
         write_enabled, health_status
  FROM infrastructure_projects
  WHERE domain = 'groups'           -- groups-1 (the intended hosting project)
  ORDER BY priority ASC, created_at ASC
  LIMIT 1
)
INSERT INTO infrastructure_projects (
  project_key, domain, provider_id, project_url, service_key, anon_key,
  status, capacity, used_space, priority, load_weight,
  write_enabled, health_status
)
SELECT s.project_key, s.domain, src.provider_id, src.project_url, src.service_key,
       src.anon_key, src.status::TEXT, src.capacity, src.used_space, src.priority,
       src.load_weight, src.write_enabled, src.health_status
FROM (VALUES
  ('group-rules-1',                 'group_rules'),
  ('group-bans-1',                  'group_member_bans'),
  ('group-restrictions-1',          'group_member_restrictions'),
  ('group-moderation-actions-1',    'group_moderation_actions'),
  ('group-reports-1',               'group_reports')
) AS s(project_key, domain)
JOIN source src ON true
ON CONFLICT (project_key) DO NOTHING;

-- 2) Keep the domains routing table in sync (informational pointer; runtime
--    routing resolves from infrastructure_projects.domain).
INSERT INTO domains (name, current_write_project)
SELECT d.name, p.id
FROM (VALUES
  ('group_rules',               'group-rules-1'),
  ('group_member_bans',         'group-bans-1'),
  ('group_member_restrictions', 'group-restrictions-1'),
  ('group_moderation_actions',  'group-moderation-actions-1'),
  ('group_reports',             'group-reports-1')
) AS d(name, project_key)
JOIN infrastructure_projects p ON p.project_key = d.project_key
ON CONFLICT (name) DO NOTHING;

COMMIT;