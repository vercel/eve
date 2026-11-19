import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { browserImageSourceKinds } from "@/lib/browser/artifact";
import { shoppers } from "./shoppers";

export const browserImages = pgTable(
  "browser_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shopperId: text("shopper_id")
      .notNull()
      .references(() => shoppers.id, { onDelete: "cascade" }),
    rootSessionId: text("root_session_id").notNull(),
    workerSessionId: text("worker_session_id").notNull(),
    status: text("status", { enum: ["pending", "ready"] }).notNull(),
    label: text("label").notNull(),
    filename: text("filename"),
    mediaType: text("media_type"),
    byteSize: integer("byte_size"),
    contentHash: text("content_hash"),
    storagePathname: text("storage_pathname").notNull(),
    sourceKind: text("source_kind", {
      enum: browserImageSourceKinds,
    }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("browser_images_status_check", sql`${table.status} IN ('pending', 'ready')`),
    check(
      "browser_images_source_kind_check",
      sql`${table.sourceKind} IN ('element', 'full_page', 'image_resource', 'viewport')`,
    ),
    check(
      "browser_images_ready_fields_check",
      sql`${table.status} = 'pending' OR (${table.filename} IS NOT NULL AND ${table.mediaType} IS NOT NULL AND ${table.byteSize} IS NOT NULL AND ${table.byteSize} > 0 AND ${table.contentHash} IS NOT NULL)`,
    ),
    uniqueIndex("browser_images_shopper_operation_idx").on(table.shopperId, table.idempotencyKey),
  ],
);
