-- Cross-replica cache for a just-authorized shared-video source. A row holds
-- only a keyed receipt fingerprint and AES-GCM ciphertext, never a viewer,
-- stream ID, receipt, media URL, or media bytes.
CREATE TABLE IF NOT EXISTS "playback_resolution_cache" (
	"receipt_hash" text PRIMARY KEY NOT NULL,
	"encrypted_payload" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playback_resolution_cache_expires_idx" ON "playback_resolution_cache" USING btree ("expires_at");
