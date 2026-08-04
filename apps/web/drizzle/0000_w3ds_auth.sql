CREATE TABLE "w3ds_login_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"platform_session_id" text,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "w3ds_login_offers_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "w3ds_platform_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"access_jti" text NOT NULL,
	"refresh_jti" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "w3ds_platform_users" (
	"id" text PRIMARY KEY NOT NULL,
	"e_name" text NOT NULL,
	"e_vault_id" text NOT NULL,
	"e_vault_uri" text,
	"display_name" text NOT NULL,
	"handle" text,
	"avatar_url" text,
	"bio" text,
	"roles" jsonb NOT NULL,
	"capabilities" jsonb NOT NULL,
	"permissions" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "w3ds_platform_users_e_name_unique" UNIQUE("e_name")
);
--> statement-breakpoint
ALTER TABLE "w3ds_platform_sessions" ADD CONSTRAINT "w3ds_platform_sessions_user_id_w3ds_platform_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."w3ds_platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "w3ds_login_offers_status_expires_idx" ON "w3ds_login_offers" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "w3ds_platform_sessions_user_id_idx" ON "w3ds_platform_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "w3ds_platform_sessions_refresh_expires_idx" ON "w3ds_platform_sessions" USING btree ("refresh_expires_at");