import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

import { describePlan } from "../lib/plan.ts";

/**
 * `ask` returns the hook, so the question can be raced against a deadline: if
 * nobody answers before the sleep, the run withdraws the request and returns
 * a timeout instead of parking forever.
 */
export default defineWorkflowTool({
  description: "Ask for deploy approval, but give up if no one answers in time.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    const pending = ctx.ask({
      display: "confirmation",
      options: [
        { id: "approve", label: "Deploy", style: "primary" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: `Apply ${describePlan(service)}?`,
    });

    const answer = await Promise.race([pending, sleep("10m")]);
    if (answer === undefined) return { decided: "timed out", service };
    return { decided: answer.optionId === "approve" ? "approved" : "rejected", service };
  },
});
