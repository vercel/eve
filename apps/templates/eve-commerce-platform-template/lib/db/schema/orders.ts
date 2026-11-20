import type { BuyCartLine } from "@agent-cards/commerce-sdk";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { shoppers } from "./shoppers";

// Agentcard's order messages carry no items, so the cart an order placed is
// kept here under its order id. A later update about the order, such as its
// delivery, can then name what was bought instead of leaving the agent to
// guess from whatever the current conversation is about.
export const agentcardOrders = pgTable(
  "agentcard_orders",
  {
    shopperId: text("shopper_id")
      .notNull()
      .references(() => shoppers.id, { onDelete: "cascade" }),
    orderId: text("order_id").notNull(),
    merchantName: text("merchant_name"),
    retailerOrderId: text("retailer_order_id"),
    items: jsonb("items").$type<readonly Pick<BuyCartLine, "name" | "qty">[]>().notNull(),
    createdAt: timestamp("created_at", {
      mode: "date",
      precision: 3,
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.shopperId, table.orderId],
      name: "agentcard_orders_pkey",
    }),
  ],
);
