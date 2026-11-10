CREATE TABLE "env_vars" (
	"app_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_ciphertext" "bytea" NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "env_vars_app_id_key_pk" PRIMARY KEY("app_id","key")
);
--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;