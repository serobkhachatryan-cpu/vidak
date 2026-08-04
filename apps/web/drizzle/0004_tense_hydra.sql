CREATE TABLE "w3ds_authorization_sync" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"local_resource_id" text NOT NULL,
	"owner_platform_user_id" text NOT NULL,
	"owner_e_name" text NOT NULL,
	"subject_platform_user_id" text,
	"subject_e_name" text NOT NULL,
	"subject_e_vault_id" text,
	"scope" text NOT NULL,
	"intent" text NOT NULL,
	"sync_status" text NOT NULL,
	"external_grant_id" text,
	"external_owner_binding_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "w3ds_authorization_sync_resource_subject_scope_uidx" ON "w3ds_authorization_sync" USING btree ("resource_id","subject_e_name","scope");--> statement-breakpoint
CREATE INDEX "w3ds_authorization_sync_status_idx" ON "w3ds_authorization_sync" USING btree ("sync_status");--> statement-breakpoint
CREATE INDEX "w3ds_authorization_sync_resource_id_idx" ON "w3ds_authorization_sync" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "w3ds_authorization_sync_owner_platform_user_id_idx" ON "w3ds_authorization_sync" USING btree ("owner_platform_user_id");