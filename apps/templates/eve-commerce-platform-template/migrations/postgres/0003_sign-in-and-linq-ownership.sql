CREATE TABLE "auth_phone_code_limits" (
	"recipient_key" text PRIMARY KEY NOT NULL,
	"sends" integer NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linq_thread_owners" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"shopper_id" text NOT NULL
);
