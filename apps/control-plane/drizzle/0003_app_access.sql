CREATE TABLE "app_access" (
	"app_id" uuid NOT NULL,
	"email" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_access_app_id_email_pk" PRIMARY KEY("app_id","email")
);
--> statement-breakpoint
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_access" ADD CONSTRAINT "app_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;