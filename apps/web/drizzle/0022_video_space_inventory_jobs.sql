-- Durable per-user video-space inventory: one job, checkpointed tasks, items,
-- and a single rate-limit gate per eVault. eNames live in these tables for
-- resume; they are never copied into logs or client extras.
CREATE TABLE IF NOT EXISTS "video_space_inventory_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_e_name" text NOT NULL,
	"owner_e_vault_uri" text NOT NULL,
	"status" text NOT NULL,
	"completeness" jsonb NOT NULL,
	"media_counts" jsonb NOT NULL,
	"ledger" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_space_inventory_jobs_owner_uidx" ON "video_space_inventory_jobs" USING btree ("owner_e_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_space_inventory_jobs_status_idx" ON "video_space_inventory_jobs" USING btree ("status","updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_space_inventory_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"task_key" text NOT NULL,
	"kind" text NOT NULL,
	"vault_key" text NOT NULL,
	"ontology_id" text,
	"cursor_after" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"priority" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_space_inventory_tasks" ADD CONSTRAINT "video_space_inventory_tasks_job_id_video_space_inventory_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."video_space_inventory_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_space_inventory_tasks_job_key_uidx" ON "video_space_inventory_tasks" USING btree ("job_id","task_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_space_inventory_tasks_claim_idx" ON "video_space_inventory_tasks" USING btree ("status","not_before","priority");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_space_inventory_tasks_job_status_idx" ON "video_space_inventory_tasks" USING btree ("job_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_space_inventory_tasks_vault_idx" ON "video_space_inventory_tasks" USING btree ("vault_key","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_space_inventory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"item_key" text NOT NULL,
	"card" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_space_inventory_items" ADD CONSTRAINT "video_space_inventory_items_job_id_video_space_inventory_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."video_space_inventory_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_space_inventory_items_job_key_uidx" ON "video_space_inventory_items" USING btree ("job_id","item_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_space_inventory_items_job_idx" ON "video_space_inventory_items" USING btree ("job_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_space_vault_gates" (
	"vault_key" text PRIMARY KEY NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"inflight_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
