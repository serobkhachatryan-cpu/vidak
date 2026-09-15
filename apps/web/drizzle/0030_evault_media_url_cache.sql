-- Durable, viewer/source-bound eVault File redirect cache. The opaque
-- generation is a write fence; an invalidation replaces it with a new random
-- value and keeps a short tombstone so an older resolver cannot resurrect a
-- rejected signed URL after the payload is cleared.
CREATE TABLE IF NOT EXISTS "evault_media_url_cache" (
	"binding_hash" text PRIMARY KEY NOT NULL,
	"generation" text NOT NULL,
	"encrypted_payload" text,
	"media_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evault_media_url_cache_expires_idx" ON "evault_media_url_cache" USING btree ("expires_at");
