import { defineDynamic, defineTool } from "eve/tools";

import { LEDGER_REGIONS } from "../lib/ledger-regions";

/** A session-scoped resolver that returns one deferred ledger tool per region. */
export default defineDynamic({
  events: {
    "session.started": () =>
      Object.fromEntries(
        LEDGER_REGIONS.map((region) => [
          `ledger_${region}`,
          defineTool({
            description: `Read the ${region.replaceAll("_", " ")} regional ledger balance for a month.`,
            deferred: true,
            inputSchema: {
              type: "object",
              properties: { month: { type: "string" } },
              required: ["month"],
            },
            execute: (input: { month: string }) => ({ balance: 1000, month: input.month, region }),
          }),
        ]),
      ),
  },
});
