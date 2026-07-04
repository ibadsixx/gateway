ALTER TABLE infrastructure_projects
ADD COLUMN IF NOT EXISTS write_enabled boolean DEFAULT true;

UPDATE infrastructure_projects SET write_enabled = true WHERE write_enabled IS NULL;
