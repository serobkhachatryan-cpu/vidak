-- A short-lived, privacy-safe tombstone for a shared card that a completed
-- live playback proof has conclusively denied. `binding_hash` is a server-keyed
-- HMAC; this table deliberately stores no viewer, item, stream, source, URL,
-- media bytes, or authorization grant.
CREATE TABLE IF NOT EXISTS "shared_playback_card_quarantines" (
	"binding_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_playback_card_quarantines_expires_idx" ON "shared_playback_card_quarantines" USING btree ("expires_at");
