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
DROP TABLE "schedule_runs", "schedules";--> statement-breakpoint
ALTER TABLE "shopping_watches" ADD CONSTRAINT "shopping_watches_shopper_id_shoppers_id_fk" FOREIGN KEY ("shopper_id") REFERENCES "public"."shoppers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shopping_watches_shopper_idx" ON "shopping_watches" USING btree ("shopper_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shopping_watches_due_idx" ON "shopping_watches" USING btree ("next_check_at") WHERE "shopping_watches"."status" IN ('active', 'ready_to_notify');