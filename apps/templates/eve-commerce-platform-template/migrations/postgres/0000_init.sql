CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"phoneNumber" text,
	"phoneNumberVerified" boolean,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email"),
	CONSTRAINT "auth_user_phoneNumber_unique" UNIQUE("phoneNumber")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopper_id" text NOT NULL,
	"root_session_id" text NOT NULL,
	"worker_session_id" text NOT NULL,
	"browser_session_id" text NOT NULL,
	"status" text NOT NULL,
	"label" text NOT NULL,
	"filename" text,
	"media_type" text,
	"byte_size" integer,
	"content_hash" text,
	"storage_pathname" text NOT NULL,
	"source_kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_images_status_check" CHECK ("browser_images"."status" IN ('pending', 'ready')),
	CONSTRAINT "browser_images_source_kind_check" CHECK ("browser_images"."source_kind" IN ('element', 'full_page', 'image_resource', 'viewport')),
	CONSTRAINT "browser_images_ready_fields_check" CHECK ("browser_images"."status" = 'pending' OR ("browser_images"."filename" IS NOT NULL AND "browser_images"."media_type" IS NOT NULL AND "browser_images"."byte_size" IS NOT NULL AND "browser_images"."byte_size" > 0 AND "browser_images"."content_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"shopper_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"worker_session_id" text
);
--> statement-breakpoint
CREATE TABLE "agentcard_orders" (
	"shopper_id" text NOT NULL,
	"order_id" text NOT NULL,
	"merchant_name" text,
	"retailer_order_id" text,
	"items" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agentcard_orders_pkey" PRIMARY KEY("shopper_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"scheduled_for" timestamp (3) with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"worker_session_id" text,
	"deferred_completion_turn_id" text,
	"pending_input_requests" jsonb,
	"outcome" jsonb,
	"report_status" text DEFAULT 'not_ready' NOT NULL,
	"report_sequence" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp (3) with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp (3) with time zone,
	"report_lease_token" uuid,
	"report_lease_expires_at" timestamp (3) with time zone,
	"last_error" text,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_runs_status_check" CHECK ("schedule_runs"."status" IN ('queued', 'running', 'waiting_for_input', 'completed', 'dead_letter')),
	CONSTRAINT "schedule_runs_report_status_check" CHECK ("schedule_runs"."report_status" IN ('not_ready', 'not_needed', 'pending', 'queued', 'delivered', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopper_id" text NOT NULL,
	"prompt" text NOT NULL,
	"conversation_channel" text NOT NULL,
	"conversation_id" text NOT NULL,
	"reply_anchor_message_id" text,
	"timing" jsonb NOT NULL,
	"missed_run_policy" text DEFAULT 'run_latest' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp (3) with time zone,
	"last_run_at" timestamp (3) with time zone,
	"last_error" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_conversation_channel_check" CHECK ("schedules"."conversation_channel" IN ('linq', 'local')),
	CONSTRAINT "schedules_conversation_id_check" CHECK ("schedules"."conversation_id" <> ''),
	CONSTRAINT "schedules_missed_run_policy_check" CHECK ("schedules"."missed_run_policy" IN ('skip', 'run_latest', 'catch_up')),
	CONSTRAINT "schedules_status_check" CHECK ("schedules"."status" IN ('active', 'paused', 'completed', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"shopper_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_delivery_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "shoppers" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"date_of_birth" date,
	"address_line_1" text,
	"address_line_2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country_code" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shoppers_country_code_check" CHECK ("shoppers"."country_code" IS NULL OR char_length("shoppers"."country_code") = 2)
);
--> statement-breakpoint
CREATE TABLE "workstreams" (
	"shopper_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"content" jsonb,
	"last_operation_id" text NOT NULL,
	"session_id" text,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workstreams_shopper_id_scope_key_id_pk" PRIMARY KEY("shopper_id","scope_key","id"),
	CONSTRAINT "workstreams_revision_check" CHECK ("workstreams"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_userId_auth_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_auth_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_images" ADD CONSTRAINT "browser_images_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentcard_orders" ADD CONSTRAINT "agentcard_orders_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_images_shopper_operation_idx" ON "browser_images" USING btree ("shopper_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "browser_sessions_shopper_idx" ON "browser_sessions" USING btree ("shopper_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_occurrence_idx" ON "schedule_runs" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "schedule_runs_ready_idx" ON "schedule_runs" USING btree ("status","retry_at" NULLS FIRST);--> statement-breakpoint
CREATE INDEX "schedule_runs_report_idx" ON "schedule_runs" USING btree ("report_status","updated_at");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("next_run_at") WHERE "schedules"."status" = 'active' AND "schedules"."next_run_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "schedules_shopper_conversation_idx" ON "schedules" USING btree ("shopper_id","conversation_channel","conversation_id","next_run_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_shopper_idx" ON "agent_sessions" USING btree ("shopper_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_latest_delivery_idx" ON "agent_sessions" USING btree ("shopper_id","last_delivery_at" DESC NULLS FIRST,"session_id" DESC NULLS FIRST) WHERE "agent_sessions"."last_delivery_at" is not null;--> statement-breakpoint
CREATE INDEX "workstreams_recent_idx" ON "workstreams" USING btree ("shopper_id","scope_key","updated_at" DESC NULLS FIRST,"id") WHERE "workstreams"."content" is not null;