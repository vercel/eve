CREATE TABLE "browser_trace_domains" (
	"trace_session_id" text NOT NULL,
	"domain" text NOT NULL,
	"first_seen_at" text NOT NULL,
	CONSTRAINT "browser_trace_domains_pkey" PRIMARY KEY("trace_session_id","domain")
);
--> statement-breakpoint
CREATE TABLE "browser_traces" (
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
ALTER TABLE "browser_sessions" ADD COLUMN "worker_session_id" text;--> statement-breakpoint
ALTER TABLE "browser_trace_domains" ADD CONSTRAINT "browser_trace_domains_trace_fkey" FOREIGN KEY ("trace_session_id") REFERENCES "public"."browser_traces"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_traces" ADD CONSTRAINT "browser_traces_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_trace_domains_domain_idx" ON "browser_trace_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "browser_traces_workspace_started_idx" ON "browser_traces" USING btree ("workspace_id","started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "browser_sessions_worker_idx" ON "browser_sessions" USING btree ("workspace_id","worker_session_id");