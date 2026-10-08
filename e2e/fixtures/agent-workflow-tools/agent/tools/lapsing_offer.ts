import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

import { describePlan } from "../lib/plan.ts";

/**
 * Offers a deploy for a few seconds, then returns without withdrawing its
 * question. The run ends with the question still open, so the session must
 * withdraw it: nobody can answer a run that has ended.
 */
export default defineWorkflowTool({
  description: "Offer to deploy a service for a few seconds, then let the offer lapse.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const answer = await Promise.race([
      ctx.ask({
        display: "confirmation",
        options: [
          { id: "approve", label: "Deploy now", style: "primary" },
          { id: "cancel", label: "Not now" },
        ],
        prompt: `Apply ${describePlan(service)} in the next few seconds?`,
      }),
      sleep("3s"),
    ]);
    return { offer: answer === undefined ? "lapsed" : "answered", service };
  },
});
