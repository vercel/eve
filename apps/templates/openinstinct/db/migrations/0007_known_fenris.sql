CREATE TABLE "scheduled_agent_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"prompt" text NOT NULL,
	"conversation_channel" text NOT NULL,
	"conversation_id" text NOT NULL,
	"timing" jsonb NOT NULL,
	"missed_run_policy" text DEFAULT 'run_latest' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp (3) with time zone,
	"last_run_at" timestamp (3) with time zone,
	"last_error" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_agent_jobs_conversation_channel_check" CHECK ("scheduled_agent_jobs"."conversation_channel" IN ('eve', 'linq')),
	CONSTRAINT "scheduled_agent_jobs_conversation_id_check" CHECK ("scheduled_agent_jobs"."conversation_id" <> ''),
	CONSTRAINT "scheduled_agent_jobs_missed_run_policy_check" CHECK ("scheduled_agent_jobs"."missed_run_policy" IN ('skip', 'run_latest', 'catch_up')),
	CONSTRAINT "scheduled_agent_jobs_status_check" CHECK ("scheduled_agent_jobs"."status" IN ('active', 'paused', 'completed', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "scheduled_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"scheduled_for" timestamp (3) with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"worker_session_id" text,
	"outcome" jsonb,
	"report_status" text DEFAULT 'not_ready' NOT NULL,
	"report_sequence" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp (3) with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp (3) with time zone,
	"last_error" text,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_agent_runs_status_check" CHECK ("scheduled_agent_runs"."status" IN ('queued', 'running', 'completed', 'dead_letter')),
	CONSTRAINT "scheduled_agent_runs_report_status_check" CHECK ("scheduled_agent_runs"."report_status" IN ('not_ready', 'not_needed', 'pending', 'queued', 'delivered', 'suppressed'))
);
--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD CONSTRAINT "scheduled_agent_jobs_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD CONSTRAINT "scheduled_agent_runs_job_id_scheduled_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scheduled_agent_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_agent_jobs_due_idx" ON "scheduled_agent_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "scheduled_agent_jobs_owner_idx" ON "scheduled_agent_jobs" USING btree ("workspace_id","created_by_user_id","conversation_channel","conversation_id","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_agent_runs_occurrence_idx" ON "scheduled_agent_runs" USING btree ("job_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "scheduled_agent_runs_ready_idx" ON "scheduled_agent_runs" USING btree ("status","retry_at" NULLS FIRST);--> statement-breakpoint
CREATE INDEX "scheduled_agent_runs_report_idx" ON "scheduled_agent_runs" USING btree ("report_status","updated_at");