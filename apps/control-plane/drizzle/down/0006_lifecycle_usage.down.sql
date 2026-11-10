DROP TABLE IF EXISTS "usage_viewers";
DROP TABLE IF EXISTS "usage_daily";
ALTER TABLE "apps" DROP COLUMN IF EXISTS "expiry_warned_at";
