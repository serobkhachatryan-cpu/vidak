-- Neutralize public names that were provisioned as the platform user id or eVault id.
-- Chosen display names are left unchanged. Safe to re-run.
UPDATE "w3ds_platform_users"
SET
	"display_name" = 'New Vidak member',
	"updated_at" = now()
WHERE "display_name" = "id"
	OR "display_name" = "e_vault_id";
