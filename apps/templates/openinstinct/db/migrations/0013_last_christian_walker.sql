CREATE TABLE "workstreams" (
	"workspace_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"content" jsonb,
	"last_operation_id" text NOT NULL,
	"session_id" text,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workstreams_workspace_id_scope_key_id_pk" PRIMARY KEY("workspace_id","scope_key","id"),
	CONSTRAINT "workstreams_revision_check" CHECK ("workstreams"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workstreams_recent_idx" ON "workstreams" USING btree ("workspace_id","scope_key","updated_at");