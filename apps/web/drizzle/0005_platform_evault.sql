CREATE TABLE "w3ds_platform_evault" (
	"id" text PRIMARY KEY NOT NULL,
	"e_name" text NOT NULL,
	"e_vault_uri" text NOT NULL,
	"platform_name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"profile_version" text NOT NULL,
	"public_url" text NOT NULL,
	"logo_url" text NOT NULL,
	"category" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "w3ds_platform_evault_e_name_unique" UNIQUE("e_name")
);
