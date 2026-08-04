ALTER TABLE "videos" ADD COLUMN "public_video_id" text;--> statement-breakpoint
CREATE INDEX "videos_public_video_id_idx" ON "videos" USING btree ("public_video_id");--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_public_video_id_unique" UNIQUE("public_video_id");