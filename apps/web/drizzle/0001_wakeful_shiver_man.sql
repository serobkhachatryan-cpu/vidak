CREATE TABLE "creator_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar_url" text,
	"banner_url" text,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"video_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "creator_channels_owner_id_unique" UNIQUE("owner_id"),
	CONSTRAINT "creator_channels_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"thumbnail_url" text DEFAULT '' NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"visibility" text NOT NULL,
	"category" text,
	"language" text,
	"tags" jsonb NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_channels" ADD CONSTRAINT "creator_channels_owner_id_w3ds_platform_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_channel_id_creator_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."creator_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_owner_id_w3ds_platform_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_channels_owner_id_idx" ON "creator_channels" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "videos_owner_id_status_idx" ON "videos" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "videos_channel_id_idx" ON "videos" USING btree ("channel_id");