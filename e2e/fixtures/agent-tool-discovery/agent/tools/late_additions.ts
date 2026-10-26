import { defineDynamic, defineTool } from "eve/tools";

import { CHARGER_UPTIME, LATE_TOOL } from "../lib/catalog";

/**
 * A deferred tool that joins the catalog mid-session: from the second turn
 * on, once the conversation has an assistant reply. It has no namespace, so
 * the catalog listing doesn't change and only the dynamic-tool hint names it.
 * Single-turn evals never see it.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (!ctx.messages.some((message) => message.role === "assistant")) return null;
      return {
        [LATE_TOOL]: defineTool({
          deferred: true,
          description:
            "Report this week's EV charger uptime for one fleet depot, and which chargers are offline.",
          inputSchema: {
            type: "object",
            properties: { depot: { type: "string", description: "Depot name" } },
            required: ["depot"],
            additionalProperties: false,
          },
          execute: () => ({ reference: `ref-${LATE_TOOL}`, ...CHARGER_UPTIME }),
        }),
      };
    },
  },
});
