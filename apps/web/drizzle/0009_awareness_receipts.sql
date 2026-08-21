CREATE TABLE "w3ds_awareness_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"global_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "w3ds_awareness_receipts_global_id_uidx" ON "w3ds_awareness_receipts" USING btree ("global_id");
