-- Local public view receipts. Never written to eVault. The stored key is a
-- one-way hash; raw IP addresses, eNames, and tokens are not persisted.
CREATE TABLE IF NOT EXISTS "video_view_events" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"public_video_id" text NOT NULL,
	"viewer_key_hash" text NOT NULL,
	"counted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_view_events" ADD CONSTRAINT "video_view_events_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "video_view_events_public_video_viewer_uidx" ON "video_view_events" USING btree ("public_video_id","viewer_key_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_view_events_video_id_idx" ON "video_view_events" USING btree ("video_id");
