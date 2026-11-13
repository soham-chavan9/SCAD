UPDATE "apps" SET "visibility" = 'allowlist' WHERE "visibility" = 'public';
ALTER TABLE "apps" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TYPE "public"."app_visibility" RENAME TO "app_visibility_old";
CREATE TYPE "public"."app_visibility" AS ENUM('allowlist', 'instance');
ALTER TABLE "apps" ALTER COLUMN "visibility" TYPE "public"."app_visibility" USING "visibility"::text::"public"."app_visibility";
ALTER TABLE "apps" ALTER COLUMN "visibility" SET DEFAULT 'allowlist';
DROP TYPE "public"."app_visibility_old";
