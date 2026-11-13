ALTER TABLE "apps" DROP CONSTRAINT IF EXISTS "apps_current_release_id_releases_id_fk";
ALTER TABLE "apps" DROP COLUMN IF EXISTS "current_release_id";
