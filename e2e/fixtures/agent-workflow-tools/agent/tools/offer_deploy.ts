import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { describePlan } from "../lib/plan.ts";

/**
 * Offers a deploy. A steering message aborts the call's `abortSignal`, which
 * withdraws the question, so the offer lapses once the conversation moves on.
 */
export default defineWorkflowTool({
  description: "Offer to deploy a service now; the offer lapses when a new message arrives.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const answer = await ctx.ask({
      display: "confirmation",
      options: [
        { id: "approve", label: "Deploy now", style: "primary" },
        { id: "cancel", label: "Not now" },
      ],
      prompt: `Apply ${describePlan(service)} now?`,
    });
    if (answer.status === "cancelled") return { offer: "withdrawn", service };
    const approved = answer.status === "answered" && answer.optionId === "approve";
    return { offer: approved ? "accepted" : "declined", service };
  },
});
