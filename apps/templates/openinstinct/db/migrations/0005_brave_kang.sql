CREATE TABLE "browser_trace_events" (
	"id" text PRIMARY KEY NOT NULL,
	"trace_session_id" text NOT NULL,
	"at" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"detail" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_trace_events" ADD CONSTRAINT "browser_trace_events_trace_fkey" FOREIGN KEY ("trace_session_id") REFERENCES "public"."browser_traces"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_trace_events_trace_idx" ON "browser_trace_events" USING btree ("trace_session_id","id");