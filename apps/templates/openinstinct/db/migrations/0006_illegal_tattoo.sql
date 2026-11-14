CREATE TABLE IF NOT EXISTS "browser_traces" (
	"session_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"task" text NOT NULL,
	"status" text NOT NULL,
	"result_message" text,
	"started_at" text NOT NULL,
	"completed_at" text,
	"duration_ms" integer,
	CONSTRAINT "browser_traces_status_check" CHECK ("browser_traces"."status" IN ('running', 'success', 'failure', 'error', 'cancelled')),
	CONSTRAINT "browser_traces_duration_ms_check" CHECK ("browser_traces"."duration_ms" IS NULL OR "browser_traces"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_trace_domains" (
	"trace_session_id" text NOT NULL,
	"domain" text NOT NULL,
	"first_seen_at" text NOT NULL,
	CONSTRAINT "browser_trace_domains_pkey" PRIMARY KEY("trace_session_id","domain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_trace_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_session_id" text NOT NULL,
	"at" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"detail" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD COLUMN IF NOT EXISTS "worker_session_id" text;
--> statement-breakpoint
DO $migration$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'browser_trace_domains_trace_fkey'
	) THEN
		ALTER TABLE "browser_trace_domains" ADD CONSTRAINT "browser_trace_domains_trace_fkey" FOREIGN KEY ("trace_session_id") REFERENCES "public"."browser_traces"("session_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $migration$;
--> statement-breakpoint
DO $migration$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'browser_traces_membership_fkey'
	) THEN
		ALTER TABLE "browser_traces" ADD CONSTRAINT "browser_traces_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $migration$;
--> statement-breakpoint
DO $migration$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'browser_trace_events_trace_fkey'
	) THEN
		ALTER TABLE "browser_trace_events" ADD CONSTRAINT "browser_trace_events_trace_fkey" FOREIGN KEY ("trace_session_id") REFERENCES "public"."browser_traces"("session_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $migration$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_trace_domains_domain_idx" ON "browser_trace_domains" USING btree ("domain");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_traces_workspace_started_idx" ON "browser_traces" USING btree ("workspace_id","started_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_trace_events_trace_idx" ON "browser_trace_events" USING btree ("trace_session_id","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_sessions_worker_idx" ON "browser_sessions" USING btree ("workspace_id","worker_session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_profiles" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"date_of_birth" text,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country_code" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "user_profiles_country_code_check" CHECK ("user_profiles"."country_code" IS NULL OR char_length("user_profiles"."country_code") = 2)
);
--> statement-breakpoint
DO $migration$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'user_profiles_workspace_id_fkey'
	) THEN
		ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $migration$;
