-- Repair stale public-profile placeholders without touching chosen names.
-- Safe to re-run. Wrapped as one statement for the migrator.
DO $$
BEGIN
	UPDATE "w3ds_platform_users"
	SET
		"handle" = NULL,
		"updated_at" = now()
	WHERE "handle" IS NOT NULL
		AND (
			"handle" LIKE 'w3ds_%'
			OR "handle" LIKE '@%'
			OR "handle" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		);

	UPDATE "w3ds_platform_users"
	SET
		"display_name" = 'New Vidak member',
		"updated_at" = now()
	WHERE lower("display_name") = 'creator';

	UPDATE "creator_channels" AS channels
	SET
		"name" = users."display_name",
		"updated_at" = now()
	FROM "w3ds_platform_users" AS users
	WHERE channels."owner_id" = users."id"
		AND lower(channels."name") = 'creator'
		AND lower(users."display_name") <> 'creator'
		AND users."display_name" <> users."id"
		AND users."display_name" NOT LIKE '@%'
		AND users."display_name" NOT LIKE 'w3ds_%';
END $$;
