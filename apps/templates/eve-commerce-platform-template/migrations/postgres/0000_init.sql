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
CREATE TABLE "auth_phone_code_limits" (
	"recipient_key" text PRIMARY KEY NOT NULL,
	"sends" integer NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL
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
CREATE TABLE "linq_thread_owners" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"shopper_id" text NOT NULL
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
CREATE TABLE "shopping_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shopper_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"product_url" text NOT NULL,
	"product_name" text NOT NULL,
	"kind" text NOT NULL,
	"target_usd_cents" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_check" text,
	"alert_text" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_watches_kind_check" CHECK (("shopping_watches"."kind" = 'price' AND "shopping_watches"."target_usd_cents" IS NOT NULL AND "shopping_watches"."target_usd_cents" > 0) OR ("shopping_watches"."kind" = 'restock' AND "shopping_watches"."target_usd_cents" IS NULL)),
	CONSTRAINT "shopping_watches_status_check" CHECK ("shopping_watches"."status" IN ('active', 'ready_to_notify', 'notified', 'stopped', 'expired')),
	CONSTRAINT "shopping_watches_alert_check" CHECK ("shopping_watches"."status" NOT IN ('ready_to_notify', 'notified') OR "shopping_watches"."alert_text" IS NOT NULL)
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
	"agent_name" text DEFAULT 'evey' NOT NULL,
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
ALTER TABLE "agentcard_orders" ADD CONSTRAINT "agentcard_orders_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_watches" ADD CONSTRAINT "shopping_watches_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_account_user_idx" ON "auth_account" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_images_shopper_operation_idx" ON "browser_images" USING btree ("shopper_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "shopping_watches_shopper_idx" ON "shopping_watches" USING btree ("shopper_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shopping_watches_due_idx" ON "shopping_watches" USING btree ("next_check_at") WHERE "shopping_watches"."status" IN ('active', 'ready_to_notify');--> statement-breakpoint
CREATE INDEX "agent_sessions_shopper_idx" ON "agent_sessions" USING btree ("shopper_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_latest_delivery_idx" ON "agent_sessions" USING btree ("shopper_id","last_delivery_at" DESC NULLS FIRST,"session_id" DESC NULLS FIRST) WHERE "agent_sessions"."last_delivery_at" is not null;--> statement-breakpoint
CREATE INDEX "workstreams_recent_idx" ON "workstreams" USING btree ("shopper_id","scope_key","updated_at" DESC NULLS FIRST,"id") WHERE "workstreams"."content" is not null;