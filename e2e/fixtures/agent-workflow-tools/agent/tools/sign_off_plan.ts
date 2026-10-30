import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { describePlan, SIGN_OFF_REQUEST } from "../lib/plan.ts";

/**
 * Resumable task that asks a person to sign off on the rollout plan. Its
 * question takes the stretch's `abortSignal`, so a cancel withdraws it, and
 * the task keeps serving later calls.
 */
export default defineWorkflowTool({
  description: "Ask a person to sign off on the rollout plan, or record a note on it.",
  inputSchema: z.strictObject({ request: z.string() }),
  async serve(receive, ctx) {
    "use workflow";

    const notes: string[] = [];
    for (;;) {
      const { input } = await receive();
      if (input.request !== SIGN_OFF_REQUEST) {
        notes.push(input.request);
        ctx.reply({ notes });
        continue;
      }
      const answer = await ctx.ask({
        display: "confirmation",
        options: [
          { id: "approve", label: "Sign off", style: "primary" },
          { id: "cancel", label: "Needs changes" },
        ],
        prompt: `Sign off on ${describePlan("api")}?`,
      });
      // The cancel that withdrew the question settled its call, which takes no reply.
      if (answer.status === "cancelled") continue;
      ctx.reply({ signedOff: answer.status === "answered" && answer.optionId === "approve" });
    }
  },
});
