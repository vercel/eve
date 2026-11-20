import { sql } from "drizzle-orm";
import { check, date, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { defaultAgentName } from "@/lib/shoppers/agent-name-schema";

// The verified eve principal ID. It also supports the fixed local shopper,
// which has no Better Auth user row.
export const shoppers = pgTable(
  "shoppers",
  {
    id: text("id").primaryKey(),
    agentName: text("agent_name").notNull().default(defaultAgentName),
    modelId: text("model_id"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    countryCode: text("country_code"),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "shoppers_country_code_check",
      sql`${table.countryCode} IS NULL OR char_length(${table.countryCode}) = 2`,
    ),
  ],
);
