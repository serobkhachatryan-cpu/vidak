ALTER TABLE "imported_channels" ADD COLUMN "source_catalogue_id" text;
--> statement-breakpoint
CREATE TABLE "imported_channel_videos" (
	"id" text PRIMARY KEY NOT NULL,
	"imported_channel_id" text NOT NULL,
	"source_video_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"source_url" text NOT NULL,
	"embed_url" text,
	"thumbnail_url" text,
	"duration_seconds" integer,
	"source_visibility" text NOT NULL,
	"playback_status" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_import_sync_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"imported_channel_id" text NOT NULL,
	"status" text NOT NULL,
	"next_cursor" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imported_channel_videos" ADD CONSTRAINT "imported_channel_videos_imported_channel_id_imported_channels_id_fk" FOREIGN KEY ("imported_channel_id") REFERENCES "public"."imported_channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_import_sync_jobs" ADD CONSTRAINT "channel_import_sync_jobs_imported_channel_id_imported_channels_id_fk" FOREIGN KEY ("imported_channel_id") REFERENCES "public"."imported_channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "imported_channel_videos_channel_source_video_uidx" ON "imported_channel_videos" USING btree ("imported_channel_id","source_video_id");
--> statement-breakpoint
CREATE INDEX "imported_channel_videos_channel_published_idx" ON "imported_channel_videos" USING btree ("imported_channel_id","published_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_import_sync_jobs_channel_uidx" ON "channel_import_sync_jobs" USING btree ("imported_channel_id");
--> statement-breakpoint
CREATE INDEX "channel_import_sync_jobs_status_locked_idx" ON "channel_import_sync_jobs" USING btree ("status","locked_until");
