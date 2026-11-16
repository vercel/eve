ALTER TABLE "browser_image_artifacts" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "browser_image_artifacts" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "browser_image_artifacts" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone USING "created_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "browser_image_artifacts" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone USING "created_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "browser_sessions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "browser_trace_domains" ALTER COLUMN "first_seen_at" SET DATA TYPE timestamp (3) with time zone USING "first_seen_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "browser_trace_events" ALTER COLUMN "at" SET DATA TYPE timestamp (3) with time zone USING "at"::timestamptz;--> statement-breakpoint
ALTER TABLE "browser_traces" ALTER COLUMN "started_at" SET DATA TYPE timestamp (3) with time zone USING "started_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "browser_traces" ALTER COLUMN "completed_at" SET DATA TYPE timestamp (3) with time zone USING "completed_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone USING "created_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone USING "updated_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "cost_usd" SET DATA TYPE numeric(16, 8) USING "cost_usd"::numeric;--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone USING "created_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "encrypted_secrets" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone USING "updated_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "encrypted_secrets" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "vault_items" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone USING "created_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "vault_items" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "vault_items" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone USING "updated_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "vault_items" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "date_of_birth" SET DATA TYPE date USING "date_of_birth"::date;--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone USING "updated_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "user_profiles" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "workspace_memberships" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone USING "created_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone USING "created_at"::timestamptz;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "created_at" SET DEFAULT now();
