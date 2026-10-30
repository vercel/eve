import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  category: "features/tools",
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      [
        "Give this agent a `query_tickets` tool so it can answer questions about our support tickets. There's no database server: the data below ships with the agent and is recreated whenever the app starts.",
        "",
        "The tool takes one read-only SQL query as a `sql` string (a SELECT, or WITH ... SELECT) and returns the column names and rows. It must refuse anything that writes or changes data, and return at most 200 rows so a large result can't flood the model's context.",
        "",
        "- `tickets(id, customer_id, priority, minutes_to_resolve, opened_at)`: (1, 20, 'high', 45, '2026-06-02'), (2, 20, 'low', 300, '2026-06-03'), (3, 21, 'high', 30, '2026-06-05'), (4, 22, 'medium', 120, '2026-06-07')",
        "- `customers(id, name, tier)`: (20, 'Umbrella', 'enterprise'), (21, 'Soylent', 'pro'), (22, 'Vandelay', 'free')",
      ].join("\n"),
    );
  },
});
