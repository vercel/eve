import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { describePlan } from "../lib/plan.ts";

/**
 * Offers a deploy and withdraws the offer once the conversation moves on:
 * the question takes the call's interruptSignal.
 */
export default defineWorkflowTool({
  description: "Offer to deploy a service now; the offer lapses when a new message arrives.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const answer = await ctx.ask(
      {
        display: "confirmation",
        options: [
          { id: "approve", label: "Deploy now", style: "primary" },
          { id: "cancel", label: "Not now" },
        ],
        prompt: `Apply ${describePlan(service)} now?`,
      },
      { signal: ctx.interruptSignal },
    );
    if (answer.status === "cancelled") return { offer: "withdrawn", service };
    const approved = answer.status === "answered" && answer.optionId === "approve";
    return { offer: approved ? "accepted" : "declined", service };
  },
});
