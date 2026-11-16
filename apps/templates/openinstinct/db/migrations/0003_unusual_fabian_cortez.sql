CREATE TABLE "browser_image_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
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
	"created_at" text NOT NULL,
	CONSTRAINT "browser_image_artifacts_status_check" CHECK ("browser_image_artifacts"."status" IN ('pending', 'ready')),
	CONSTRAINT "browser_image_artifacts_source_kind_check" CHECK ("browser_image_artifacts"."source_kind" IN ('element', 'full_page', 'image_resource', 'viewport')),
	CONSTRAINT "browser_image_artifacts_ready_fields_check" CHECK ("browser_image_artifacts"."status" = 'pending' OR ("browser_image_artifacts"."filename" IS NOT NULL AND "browser_image_artifacts"."media_type" IS NOT NULL AND "browser_image_artifacts"."byte_size" > 0 AND "browser_image_artifacts"."content_hash" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "browser_image_artifacts" ADD CONSTRAINT "browser_image_artifacts_membership_fkey" FOREIGN KEY ("workspace_id","created_by_user_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_image_artifacts_workspace_idempotency_uidx" ON "browser_image_artifacts" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "browser_image_artifacts_workspace_created_idx" ON "browser_image_artifacts" USING btree ("workspace_id","created_at" DESC NULLS FIRST);