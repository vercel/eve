import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { describePlan } from "../lib/plan.ts";

/** A task that asks a person to approve a rollout while the conversation continues. */
export default defineWorkflowTool({
  description: "Ask for approval to roll out a service, then report the decision.",
  inputSchema: z.strictObject({ service: z.string() }),
  async task({ service }, ctx) {
    "use workflow";

    const answer = await ctx.ask({
      display: "confirmation",
      options: [
        { id: "approve", label: "Roll out", style: "primary" },
        { id: "cancel", label: "Not now" },
      ],
      prompt: `Roll out ${describePlan(service)}?`,
    });
    return { approved: answer.status === "answered" && answer.optionId === "approve", service };
  },
});
