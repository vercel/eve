import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { describePlan } from "../lib/plan.ts";

/**
 * Waiting workflow tool that asks the human mid-body. The request belongs to
 * the run, and the answer resumes the hook `ask` returns.
 */
export default defineWorkflowTool({
  description: "Deploy a service after a human approves the plan.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const answer = await ctx.ask({
      display: "confirmation",
      options: [
        { id: "approve", label: "Deploy", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: `Apply ${describePlan(service)}?`,
    });
    return { approved: answer.optionId === "approve", service };
  },
});
