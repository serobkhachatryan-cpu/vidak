-- Server-only, short-lived tickets for continuous call-recording playback.
-- The rows deliberately contain only opaque stream grants and an internal
-- segment capability; resolved source URLs and media bytes never enter SQL.
CREATE TABLE IF NOT EXISTS "recording_concat_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"viewer_e_name" text NOT NULL,
	"viewer_e_name_key" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL,
	"active_lease_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recording_concat_tickets_expires_idx" ON "recording_concat_tickets" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recording_concat_tickets_viewer_expires_idx" ON "recording_concat_tickets" USING btree ("viewer_e_name_key","expires_at");
--> statement-breakpoint
-- A single row is locked transactionally when a new ticket is issued, making
-- the global and per-viewer admission limits exact across all app replicas.
CREATE TABLE IF NOT EXISTS "recording_concat_ticket_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
