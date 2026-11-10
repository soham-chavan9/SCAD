ALTER TABLE "machines" ADD COLUMN "running_seconds" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "volume_bytes" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "volume_measured_at" timestamp with time zone;