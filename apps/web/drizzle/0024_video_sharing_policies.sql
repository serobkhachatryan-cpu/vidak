CREATE TABLE IF NOT EXISTS "video_sharing_policies" (
	"video_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"audience" text NOT NULL,
	"reader_e_names" jsonb NOT NULL,
	"group_e_names" jsonb NOT NULL,
	"share_token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "video_sharing_policies_share_token_unique" UNIQUE("share_token")
);
--> statement-breakpoint
ALTER TABLE "video_sharing_policies" ADD CONSTRAINT "video_sharing_policies_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "video_sharing_policies" ADD CONSTRAINT "video_sharing_policies_owner_id_w3ds_platform_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_sharing_policies_owner_id_idx" ON "video_sharing_policies" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_sharing_policies_share_token_idx" ON "video_sharing_policies" USING btree ("share_token");
