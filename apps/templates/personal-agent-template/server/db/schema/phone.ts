import { primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const phoneLinks = sqliteTable(
  "phone_links",
  {
    appUserId: text("app_user_id").notNull(),
    phoneNumber: text("phone_number").notNull(),
    linkedAt: text("linked_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.phoneNumber] }),
    uniqueIndex("phone_links_app_user_idx").on(table.appUserId),
  ],
);
