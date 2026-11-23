import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { shoppers } from "./shoppers";

export const shoppingWatches = pgTable(
  "shopping_watches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shopperId: text("shopper_id")
      .notNull()
      .references(() => shoppers.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    productUrl: text("product_url").notNull(),
    productName: text("product_name").notNull(),
    kind: text("kind", { enum: ["price", "restock"] }).notNull(),
    targetUsdCents: integer("target_usd_cents"),
    status: text("status", {
      enum: ["active", "ready_to_notify", "notified", "stopped", "expired"],
    })
      .notNull()
      .default("active"),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastCheck: text("last_check", { enum: ["unreadable", "no_match", "matched"] }),
    alertText: text("alert_text"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "shopping_watches_kind_check",
      sql`(${table.kind} = 'price' AND ${table.targetUsdCents} IS NOT NULL AND ${table.targetUsdCents} > 0) OR (${table.kind} = 'restock' AND ${table.targetUsdCents} IS NULL)`,
    ),
    check(
      "shopping_watches_status_check",
      sql`${table.status} IN ('active', 'ready_to_notify', 'notified', 'stopped', 'expired')`,
    ),
    check(
      "shopping_watches_alert_check",
      sql`${table.status} NOT IN ('ready_to_notify', 'notified') OR ${table.alertText} IS NOT NULL`,
    ),
    index("shopping_watches_shopper_idx").on(table.shopperId, table.createdAt.desc()),
    index("shopping_watches_due_idx")
      .on(table.nextCheckAt)
      .where(sql`${table.status} IN ('active', 'ready_to_notify')`),
  ],
);
