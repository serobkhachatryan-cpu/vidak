ALTER TABLE "w3ds_awareness_receipts" ADD COLUMN "payload_hash" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "w3ds_awareness_receipts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
