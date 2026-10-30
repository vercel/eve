import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

import { revise } from "../lib/plan-revisions.ts";

/**
 * Resumable task: one run keeps the plan across calls made with its taskId.
 * Each revision replies with every revision so far, so a result shows whether
 * later calls reached the same run.
 */
export default defineWorkflowTool({
  description: "Draft a rollout plan and revise it on request.",
  inputSchema: z.strictObject({ request: z.string() }),
  async serve(receive, ctx) {
    "use workflow";

    const revisions: string[] = [];
    for (;;) {
      const { input, abortSignal } = await receive();
      try {
        revisions.push(await revise(input.request, abortSignal));
        ctx.reply({ revisions });
      } catch (error) {
        // A cancel settles this stretch's calls; catching its abort keeps the task available.
        if (!abortSignal.aborted) throw error;
      }
    }
  },
});
