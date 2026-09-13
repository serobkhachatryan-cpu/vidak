-- A short-lived, cross-replica ordering fence for explicit shared-video
-- source recovery. The binding and lease are keyed hashes; the source URL is
-- AES-GCM ciphertext. No viewer identity, stream grant, receipt, or URL is
-- persisted in plaintext.
CREATE TABLE IF NOT EXISTS "playback_source_refresh_epochs" (
	"binding_hash" text PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"status" text NOT NULL,
	"lease_hash" text,
	"lease_expires_at" timestamp with time zone,
	"encrypted_payload" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playback_source_refresh_epochs_expires_idx" ON "playback_source_refresh_epochs" USING btree ("expires_at");
