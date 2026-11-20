import { isNotNull, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { WorkstreamContent } from "@/lib/workstreams/schema";
import { shoppers } from "./shoppers";

export const workstreams = pgTable(
  "workstreams",
  {
    shopperId: text("shopper_id")
      .notNull()
      .references(() => shoppers.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    content: jsonb("content").$type<WorkstreamContent>(),
    lastOperationId: text("last_operation_id").notNull(),
    sessionId: text("session_id"),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shopperId, table.scopeKey, table.id] }),
    index("workstreams_recent_idx")
      .on(table.shopperId, table.scopeKey, table.updatedAt.desc().nullsFirst(), table.id)
      .where(isNotNull(table.content)),
    check("workstreams_revision_check", sql`${table.revision} > 0`),
  ],
);
