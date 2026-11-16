ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "channel" text;
--> statement-breakpoint
ALTER TABLE "scheduled_agent_jobs" ADD COLUMN IF NOT EXISTS "reply_anchor_message_id" text;
