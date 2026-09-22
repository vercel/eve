import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { z } from "zod";

import { fixtureUrl } from "../lib/fake-service.ts";

const resultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

export default defineDynamic({
  events: {
    "session.started": () =>
      defineMcpClientConnection({
        description: "Catalog that returns a compact item count instead of item details.",
        url: fixtureUrl("/fixture-catalog/mcp").href,
        instanceKey: "fixture-compact-catalog",
        auth: { getToken: async () => ({ token: "authorized-fixture-token" }) },
        toolCall: {
          toModelOutput: {
            list_items(result) {
              const parsed = resultSchema.parse(result);
              return { type: "json", value: { itemCount: parsed.content.length } };
            },
          },
        },
      }),
  },
});
