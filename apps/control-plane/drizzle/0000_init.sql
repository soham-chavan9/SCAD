CREATE TYPE "public"."app_status" AS ENUM('building', 'running', 'stopped', 'suspended', 'expired', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."app_visibility" AS ENUM('allowlist', 'instance');--> statement-breakpoint
CREATE TYPE "public"."release_status" AS ENUM('building', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('operator', 'member');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"status" "app_status" DEFAULT 'stopped' NOT NULL,
	"visibility" "app_visibility" DEFAULT 'allowlist' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "apps_owner_slug" UNIQUE("owner_id","slug")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"app_id" uuid,
	"action" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"app_id" uuid PRIMARY KEY NOT NULL,
	"provider_id" text DEFAULT '' NOT NULL,
	"volume_ref" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'missing' NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_request_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "pats_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"image_ref" text DEFAULT '' NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "release_status" DEFAULT 'building' NOT NULL,
	"build_log_ref" text,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "releases_app_version" UNIQUE("app_id","version")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"github_id" text,
	"handle" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pats" ADD CONSTRAINT "pats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;