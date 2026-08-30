-- Local still-frame preview cache. Bytes stay in MediaStorage; this table
-- never grants public access and is not synced to eVault.
CREATE TABLE IF NOT EXISTS "video_preview_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"source_key" text NOT NULL,
	"storage_key" text,
	"status" text NOT NULL,
	"capture_seconds" integer,
	"byte_size" integer,
	"content_type" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_preview_assets_source_uidx" ON "video_preview_assets" USING btree ("source_kind","source_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_preview_assets_status_idx" ON "video_preview_assets" USING btree ("status");
