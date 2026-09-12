-- Server-only viewer-vault Chat-envelope pointers for direct shared-video
-- discovery. These records are never authorization decisions and never store
-- media URLs, media bytes, stream grants, or source credentials.
CREATE TABLE IF NOT EXISTS "viewer_chat_grant_pointers" (
	"viewer_e_name" text NOT NULL,
	"source_e_name" text NOT NULL,
	"source_chat_id" text NOT NULL,
	"viewer_envelope_id" text NOT NULL,
	"envelope_hash" text,
	"state" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "viewer_chat_grant_pointers_identity_uidx" ON "viewer_chat_grant_pointers" USING btree ("viewer_e_name","source_e_name","source_chat_id","viewer_envelope_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "viewer_chat_grant_pointers_candidates_idx" ON "viewer_chat_grant_pointers" USING btree ("viewer_e_name","source_e_name","source_chat_id","state","observed_at");
