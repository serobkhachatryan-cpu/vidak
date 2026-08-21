CREATE TABLE "w3ds_video_publication_signing_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"video_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"owner_e_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "w3ds_video_publication_signing_sessions" ADD CONSTRAINT "w3ds_video_publication_signing_sessions_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "w3ds_video_publication_signing_sessions" ADD CONSTRAINT "w3ds_video_publication_signing_sessions_owner_id_w3ds_platform_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "w3ds_video_publication_signing_status_expires_idx" ON "w3ds_video_publication_signing_sessions" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "w3ds_video_publication_signing_owner_video_idx" ON "w3ds_video_publication_signing_sessions" USING btree ("owner_id","video_id");
