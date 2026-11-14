-- This first migration is intentionally additive: production databases may
-- already contain the tables formerly created by lib/server/app-store.ts.
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_memberships_role_check" CHECK ("workspace_memberships"."role" = 'owner'),
	CONSTRAINT "workspace_memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_items" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"account" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "vault_items_kind_check" CHECK ("vault_items"."kind" IN ('login', 'payment', 'address', 'phone', 'identity', 'token')),
	CONSTRAINT "vault_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "settings_pkey" PRIMARY KEY("workspace_id","key"),
	CONSTRAINT "settings_key_check" CHECK ("settings"."key" = 'gateway_model'),
	CONSTRAINT "settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "agent_sessions_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "browser_sessions_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chats" (
	"session_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision,
	CONSTRAINT "chats_input_tokens_check" CHECK ("chats"."input_tokens" >= 0),
	CONSTRAINT "chats_output_tokens_check" CHECK ("chats"."output_tokens" >= 0),
	CONSTRAINT "chats_cost_usd_check" CHECK ("chats"."cost_usd" IS NULL OR "chats"."cost_usd" >= 0),
	CONSTRAINT "chats_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Older runtime-created chat tables may predate usage accounting.
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "input_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "output_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "cost_usd" double precision;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "encrypted_secrets" (
	"workspace_id" text NOT NULL,
	"namespace" text NOT NULL,
	"id" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "encrypted_secrets_pkey" PRIMARY KEY("workspace_id","namespace","id"),
	CONSTRAINT "encrypted_secrets_namespace_check" CHECK ("encrypted_secrets"."namespace" = 'vault'),
	CONSTRAINT "encrypted_secrets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Constraints on pre-existing data are installed NOT VALID. PostgreSQL enforces
-- them for new writes immediately; operators can audit and validate historical
-- rows separately after this deployment.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.workspace_memberships'::regclass AND conname = 'workspace_memberships_workspace_id_fkey') THEN
		ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.workspace_memberships'::regclass AND conname = 'workspace_memberships_role_check') THEN
		ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_role_check" CHECK ("role" = 'owner') NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.vault_items'::regclass AND conname = 'vault_items_workspace_id_fkey') THEN
		ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.vault_items'::regclass AND conname = 'vault_items_kind_check') THEN
		ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_kind_check" CHECK ("kind" IN ('login', 'payment', 'address', 'phone', 'identity', 'token')) NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.settings'::regclass AND conname = 'settings_workspace_id_fkey') THEN
		ALTER TABLE "settings" ADD CONSTRAINT "settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.settings'::regclass AND conname = 'settings_key_check') THEN
		ALTER TABLE "settings" ADD CONSTRAINT "settings_key_check" CHECK ("key" = 'gateway_model') NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_sessions'::regclass AND conname = 'agent_sessions_membership_fkey') THEN
		ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.browser_sessions'::regclass AND conname = 'browser_sessions_membership_fkey') THEN
		ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chats'::regclass AND conname = 'chats_workspace_id_fkey') THEN
		ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chats'::regclass AND conname = 'chats_input_tokens_check') THEN
		ALTER TABLE "chats" ADD CONSTRAINT "chats_input_tokens_check" CHECK ("input_tokens" >= 0) NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chats'::regclass AND conname = 'chats_output_tokens_check') THEN
		ALTER TABLE "chats" ADD CONSTRAINT "chats_output_tokens_check" CHECK ("output_tokens" >= 0) NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chats'::regclass AND conname = 'chats_cost_usd_check') THEN
		ALTER TABLE "chats" ADD CONSTRAINT "chats_cost_usd_check" CHECK ("cost_usd" IS NULL OR "cost_usd" >= 0) NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.encrypted_secrets'::regclass AND conname = 'encrypted_secrets_workspace_id_fkey') THEN
		ALTER TABLE "encrypted_secrets" ADD CONSTRAINT "encrypted_secrets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.encrypted_secrets'::regclass AND conname = 'encrypted_secrets_namespace_check') THEN
		ALTER TABLE "encrypted_secrets" ADD CONSTRAINT "encrypted_secrets_namespace_check" CHECK ("namespace" = 'vault') NOT VALID;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sessions_workspace_idx" ON "agent_sessions" USING btree ("workspace_id","created_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "browser_sessions_workspace_idx" ON "browser_sessions" USING btree ("workspace_id","created_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chats_workspace_updated_idx" ON "chats" USING btree ("workspace_id","updated_at" DESC NULLS FIRST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_items_workspace_updated_idx" ON "vault_items" USING btree ("workspace_id","updated_at" DESC NULLS FIRST);
