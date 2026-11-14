ALTER TABLE "scheduled_agent_runs" DROP CONSTRAINT "scheduled_agent_runs_status_check";--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD COLUMN "pending_input_requests" jsonb;--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD COLUMN "report_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD COLUMN "report_lease_expires_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_agent_runs" ADD CONSTRAINT "scheduled_agent_runs_status_check" CHECK ("scheduled_agent_runs"."status" IN ('queued', 'running', 'waiting_for_input', 'completed', 'dead_letter'));
