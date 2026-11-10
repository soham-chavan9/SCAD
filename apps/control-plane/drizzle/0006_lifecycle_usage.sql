CREATE TABLE "usage_daily" (
	"app_id" uuid NOT NULL,
	"day" date NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"unique_viewers" integer DEFAULT 0 NOT NULL,
	"egress_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_app_id_day_pk" PRIMARY KEY("app_id","day")
);
--> statement-breakpoint
CREATE TABLE "usage_viewers" (
	"app_id" uuid NOT NULL,
	"day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_viewers_app_id_day_user_id_pk" PRIMARY KEY("app_id","day","user_id")
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "expiry_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_viewers" ADD CONSTRAINT "usage_viewers_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_viewers" ADD CONSTRAINT "usage_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;