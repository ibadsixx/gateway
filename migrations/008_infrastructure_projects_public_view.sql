-- Tone Gateway Infrastructure — Public configuration view migration.
--
-- Creates a restricted public view of infrastructure_projects exposing only the
-- fields safe for frontend consumption. Privileged columns (service_key,
-- jwt_secret, etc.) are never exposed. The frontend reads exclusively through
-- this view; no SELECT privilege is granted on the underlying
-- infrastructure_projects table to anon or authenticated roles.
--
-- This migration must be applied to the Infrastructure Supabase project.
-- DO NOT deploy without explicit approval.
--
-- Migration: 008_infrastructure_projects_public_view.sql

-- ---------------------------------------------------------------------------
-- 0. Revoke all table-level privileges on the base infrastructure_projects
--    table from frontend roles. Do not revoke privileges from postgres or
--    service_role. Do not revoke USAGE on schema public.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.infrastructure_projects FROM anon;
REVOKE ALL ON public.infrastructure_projects FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. Create a restricted public view of infrastructure_projects.
--    Only columns safe for frontend consumption are included.
--    security_barrier prevents the optimizer from pushing down conditions
--    that could bypass column-level restrictions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.infrastructure_projects_public AS
SELECT
  project_key,
  domain,
  project_url,
  anon_key,
  status,
  priority,
  region,
  health_status
FROM public.infrastructure_projects
WHERE status = 'active';

ALTER VIEW public.infrastructure_projects_public
  SET (security_barrier = true);

ALTER VIEW public.infrastructure_projects_public OWNER TO postgres;

-- ---------------------------------------------------------------------------
-- 3. Grant SELECT on the public view ONLY.
--    Direct table access for sensitive columns is NOT granted to anon or
--    authenticated roles; the view is the sanctioned access path. No policy
--    is created on the underlying infrastructure_projects table for frontend
--    access, and no existing infrastructure policies are modified.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.infrastructure_projects_public TO anon;
GRANT SELECT ON public.infrastructure_projects_public TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Comment for documentation.
-- ---------------------------------------------------------------------------
COMMENT ON VIEW public.infrastructure_projects_public IS
  'Restricted public view of active infrastructure projects. Exposes only
  project_key, domain, project_url, anon_key, status, priority, region,
  health_status. service_key, jwt_secret and other privileged columns are
  never exposed. Frontend uses this view for domain-project configuration
  discovery. Deploy only with explicit approval.';
