CREATE TABLE "w3ds_private_adapter_projections" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"local_id" text NOT NULL,
	"global_id" text NOT NULL,
	"schema_id" text NOT NULL,
	"owner_e_name" text NOT NULL,
	"ownership" text DEFAULT 'vidak_private' NOT NULL,
	"catalogue_visibility" text DEFAULT 'private' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"mapping_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "w3ds_private_adapter_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"local_id" text NOT NULL,
	"operation" text NOT NULL,
	"sync_status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"failure_reason" text,
	"correlation_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "w3ds_private_adapter_projections_entity_type_local_id_uidx" ON "w3ds_private_adapter_projections" USING btree ("entity_type","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "w3ds_private_adapter_projections_global_id_uidx" ON "w3ds_private_adapter_projections" USING btree ("global_id");--> statement-breakpoint
CREATE INDEX "w3ds_private_adapter_projections_schema_id_idx" ON "w3ds_private_adapter_projections" USING btree ("schema_id");--> statement-breakpoint
CREATE INDEX "w3ds_private_adapter_projections_owner_e_name_idx" ON "w3ds_private_adapter_projections" USING btree ("owner_e_name");--> statement-breakpoint
CREATE INDEX "w3ds_private_adapter_projections_sync_lookup_idx" ON "w3ds_private_adapter_projections" USING btree ("entity_type","payload_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "w3ds_private_adapter_outbox_entity_type_local_id_uidx" ON "w3ds_private_adapter_outbox" USING btree ("entity_type","local_id");--> statement-breakpoint
CREATE INDEX "w3ds_private_adapter_outbox_status_idx" ON "w3ds_private_adapter_outbox" USING btree ("sync_status");--> statement-breakpoint
CREATE INDEX "w3ds_private_adapter_outbox_entity_type_status_idx" ON "w3ds_private_adapter_outbox" USING btree ("entity_type","sync_status");
