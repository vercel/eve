import { index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const slackLinks = sqliteTable(
  "slack_links",
  {
    appUserId: text("app_user_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    slackUserName: text("slack_user_name"),
    slackDisplayName: text("slack_display_name"),
    slackEmail: text("slack_email"),
    linkedAt: text("linked_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.slackTeamId, table.slackUserId] }),
    uniqueIndex("slack_links_app_user_idx").on(table.appUserId),
  ],
);

export const slackLinkCodes = sqliteTable(
  "slack_link_codes",
  {
    code: text().primaryKey(),
    appUserId: text("app_user_id").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index("slack_link_codes_app_user_idx").on(table.appUserId)],
);
