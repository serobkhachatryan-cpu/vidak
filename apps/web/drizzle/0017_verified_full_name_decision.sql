-- Persist whether the person already answered the verified-full-name consent prompt.
-- Null means they have not decided yet. Safe to re-run.
ALTER TABLE "w3ds_platform_users"
	ADD COLUMN IF NOT EXISTS "verified_full_name_decision" text;
