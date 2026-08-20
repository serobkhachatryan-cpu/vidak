CREATE TABLE "w3ds_official_adapter_outbox" (
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
CREATE UNIQUE INDEX "w3ds_official_adapter_outbox_entity_type_local_id_uidx" ON "w3ds_official_adapter_outbox" USING btree ("entity_type","local_id");--> statement-breakpoint
CREATE INDEX "w3ds_official_adapter_outbox_status_idx" ON "w3ds_official_adapter_outbox" USING btree ("sync_status");--> statement-breakpoint
CREATE INDEX "w3ds_official_adapter_outbox_entity_type_status_idx" ON "w3ds_official_adapter_outbox" USING btree ("entity_type","sync_status");
