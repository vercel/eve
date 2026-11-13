import { sql } from "drizzle-orm";
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
import type { WorkstreamContent } from "@shared/workstreams/schema";
import { workspaces } from "./workspaces";

export const workstreams = pgTable(
  "workstreams",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
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
    primaryKey({ columns: [table.workspaceId, table.scopeKey, table.id] }),
    index("workstreams_recent_idx").on(
      table.workspaceId,
      table.scopeKey,
      table.updatedAt
    ),
    check("workstreams_revision_check", sql`${table.revision} > 0`),
  ]
);
