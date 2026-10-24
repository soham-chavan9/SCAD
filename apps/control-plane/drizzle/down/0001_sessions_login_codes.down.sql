ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_user_id_users_id_fk";
ALTER TABLE "login_codes" DROP CONSTRAINT IF EXISTS "login_codes_user_id_users_id_fk";
DROP TABLE IF EXISTS "sessions";
DROP TABLE IF EXISTS "oauth_states";
DROP TABLE IF EXISTS "login_codes";
