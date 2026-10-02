import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { chooseCapability } from "#lib/decisions.js";

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      const capability = await chooseCapability({
        messages: ctx.messages,
        abortSignal: ctx.abortSignal,
      });

      if (capability === "incident") {
        return {
          inspect_incident: defineTool({
            description: "Inspect simulated incident status for a service.",
            inputSchema: z.object({ service: z.string().min(1).max(120) }),
            execute: async ({ service }) => ({
              service,
              status: "investigating",
              note: "Demonstration data only; no production system was queried.",
            }),
          }),
        };
      }

      if (capability === "support") {
        return {
          draft_support_reply: defineTool({
            description: "Draft a concise customer-support reply from an issue summary.",
            inputSchema: z.object({ issue: z.string().min(1).max(4_000) }),
            execute: async ({ issue }) => ({
              draft: `Thanks for reporting this. We are investigating: ${issue}`,
              note: "Demonstration draft only; it was not sent to a customer.",
            }),
          }),
        };
      }

      return null;
    },
  },
});
