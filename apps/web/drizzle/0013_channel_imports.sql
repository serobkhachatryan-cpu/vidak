CREATE TABLE "channel_import_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"account_label" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"granted_scopes" jsonb NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imported_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"source_channel_id" text NOT NULL,
	"title" text NOT NULL,
	"source_url" text NOT NULL,
	"thumbnail_url" text,
	"status" text NOT NULL,
	"imported_video_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_import_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "channel_import_oauth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "channel_import_connections" ADD CONSTRAINT "channel_import_connections_owner_id_w3ds_platform_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "imported_channels" ADD CONSTRAINT "imported_channels_connection_id_channel_import_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."channel_import_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_import_oauth_states" ADD CONSTRAINT "channel_import_oauth_states_owner_id_w3ds_platform_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_import_connections_owner_provider_account_uidx" ON "channel_import_connections" USING btree ("owner_id","provider","provider_account_id");
--> statement-breakpoint
CREATE INDEX "channel_import_connections_owner_id_idx" ON "channel_import_connections" USING btree ("owner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "imported_channels_connection_source_channel_uidx" ON "imported_channels" USING btree ("connection_id","source_channel_id");
--> statement-breakpoint
CREATE INDEX "imported_channels_connection_id_idx" ON "imported_channels" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX "imported_channels_status_idx" ON "imported_channels" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "channel_import_oauth_states_provider_expires_idx" ON "channel_import_oauth_states" USING btree ("provider","expires_at");
--> statement-breakpoint
CREATE INDEX "channel_import_oauth_states_owner_id_idx" ON "channel_import_oauth_states" USING btree ("owner_id");
