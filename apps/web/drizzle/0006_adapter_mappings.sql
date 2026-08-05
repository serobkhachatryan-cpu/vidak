CREATE TABLE "w3ds_adapter_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_table" text NOT NULL,
	"local_id" text NOT NULL,
	"global_id" text NOT NULL,
	"owner_e_name" text NOT NULL,
	"schema_id" text NOT NULL,
	"mapping_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "w3ds_adapter_mappings_entity_type_local_id_uidx" ON "w3ds_adapter_mappings" USING btree ("entity_type","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "w3ds_adapter_mappings_global_id_uidx" ON "w3ds_adapter_mappings" USING btree ("global_id");--> statement-breakpoint
CREATE INDEX "w3ds_adapter_mappings_owner_e_name_idx" ON "w3ds_adapter_mappings" USING btree ("owner_e_name");--> statement-breakpoint
CREATE INDEX "w3ds_adapter_mappings_schema_id_idx" ON "w3ds_adapter_mappings" USING btree ("schema_id");--> statement-breakpoint
CREATE INDEX "w3ds_adapter_mappings_entity_table_local_id_idx" ON "w3ds_adapter_mappings" USING btree ("entity_table","local_id");
