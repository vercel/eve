import { isNotNull } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { shoppers } from "./shoppers";

// eve owns execution and history. This table records ownership and the last
// consumed delivery used to route unthreaded Agentcard updates.
export const agentSessions = pgTable(
  "agent_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    shopperId: text("shopper_id")
      .notNull()
      .references(() => shoppers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
    lastDeliveryAt: timestamp("last_delivery_at", {
      precision: 3,
      withTimezone: true,
    }),
  },
  (table) => [
    index("agent_sessions_shopper_idx").on(table.shopperId),
    index("agent_sessions_latest_delivery_idx")
      .on(
        table.shopperId,
        table.lastDeliveryAt.desc().nullsFirst(),
        table.sessionId.desc().nullsFirst(),
      )
      .where(isNotNull(table.lastDeliveryAt)),
  ],
);
