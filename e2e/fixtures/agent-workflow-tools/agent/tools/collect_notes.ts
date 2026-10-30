import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

/**
 * Resumable task that collects notes on the rollout. A note sent with `more`
 * waits for the next one, so a single reply answers both calls.
 */
export default defineWorkflowTool({
  description: "Collect notes on the rollout; set more when another note follows.",
  inputSchema: z.strictObject({ more: z.boolean().optional(), note: z.string() }),
  async serve(receive, ctx) {
    "use workflow";

    const notes: string[] = [];
    for (;;) {
      const { input } = await receive();
      notes.push(input.note);
      if (input.more === true) continue;
      ctx.reply({ notes });
    }
  },
});
