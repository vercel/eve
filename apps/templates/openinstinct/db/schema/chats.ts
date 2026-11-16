import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

export const chats = pgTable(
  "chats",
  {
    sessionId: text("session_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    channel: text("channel"),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", {
      mode: "number",
      precision: 16,
      scale: 8,
    }),
  },
  (table) => [
    foreignKey({
      name: "chats_workspace_id_fkey",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    check("chats_input_tokens_check", sql`${table.inputTokens} >= 0`),
    check("chats_output_tokens_check", sql`${table.outputTokens} >= 0`),
    check(
      "chats_cost_usd_check",
      sql`${table.costUsd} IS NULL OR ${table.costUsd} >= 0`
    ),
    index("chats_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt.desc().nullsFirst()
    ),
  ]
);

export const chatsRelations = relations(chats, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [chats.workspaceId],
    references: [workspaces.id],
  }),
}));
