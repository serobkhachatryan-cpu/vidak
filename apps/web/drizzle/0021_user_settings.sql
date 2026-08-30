-- Durable Settings preferences and opaque avatar storage keys.
-- Avatar bytes live in MediaStorage; this table never stores image payloads.
ALTER TABLE "w3ds_platform_users" ADD COLUMN IF NOT EXISTS "avatar_storage_key" text;
--> statement-breakpoint
ALTER TABLE "w3ds_platform_users" ADD COLUMN IF NOT EXISTS "avatar_content_type" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"appearance" text NOT NULL,
	"language" text NOT NULL,
	"notifications" jsonb NOT NULL,
	"privacy" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_w3ds_platform_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE cascade ON UPDATE no action;
