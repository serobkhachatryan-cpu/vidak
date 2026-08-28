ALTER TABLE "channel_import_connections" ADD COLUMN "connection_kind" text DEFAULT 'oauth' NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_import_connections" ALTER COLUMN "encrypted_access_token" DROP NOT NULL;
