CREATE TABLE "runtime_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"line" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_logs" ADD CONSTRAINT "runtime_logs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_logs_app_id_id_idx" ON "runtime_logs" USING btree ("app_id","id");--> statement-breakpoint
CREATE INDEX "runtime_logs_app_provider_idx" ON "runtime_logs" USING btree ("app_id","provider_id");--> statement-breakpoint
CREATE INDEX "runtime_logs_at_idx" ON "runtime_logs" USING btree ("at");