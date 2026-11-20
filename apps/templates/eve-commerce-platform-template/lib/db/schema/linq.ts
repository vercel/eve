import { pgTable, text } from "drizzle-orm/pg-core";

// Keep the binding even if a shopper account is removed: a reassigned Linq
// identity must not inherit the former shopper's eve thread history.
export const linqThreadOwners = pgTable("linq_thread_owners", {
  chatId: text("chat_id").primaryKey(),
  shopperId: text("shopper_id").notNull(),
});
