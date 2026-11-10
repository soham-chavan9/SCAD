ALTER TABLE "app_access" DROP CONSTRAINT IF EXISTS "app_access_granted_by_users_id_fk";
ALTER TABLE "app_access" DROP CONSTRAINT IF EXISTS "app_access_app_id_apps_id_fk";
DROP TABLE IF EXISTS "app_access";
