CREATE TABLE "support_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reporter_id" text NOT NULL,
	"description" text NOT NULL,
	"technical_diagnostics" jsonb,
	"diagnostics_consent" boolean DEFAULT false NOT NULL,
	"automated_analysis_consent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"status" text NOT NULL,
	"analysis_attempt_count" integer DEFAULT 0 NOT NULL,
	"last_analyzed_at" timestamp with time zone,
	"resolution_summary" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "support_tasks_report_id_unique" UNIQUE("report_id")
);
--> statement-breakpoint
ALTER TABLE "support_reports" ADD CONSTRAINT "support_reports_reporter_id_w3ds_platform_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "support_tasks" ADD CONSTRAINT "support_tasks_report_id_support_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."support_reports"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "support_reports_reporter_created_idx" ON "support_reports" USING btree ("reporter_id","created_at");
--> statement-breakpoint
CREATE INDEX "support_tasks_status_created_idx" ON "support_tasks" USING btree ("status","created_at");
