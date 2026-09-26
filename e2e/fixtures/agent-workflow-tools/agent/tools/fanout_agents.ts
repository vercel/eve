import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Call two workflow-owned subagents in parallel and return both inline results.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute(ctx) {
    "use workflow";

    const { service } = (await ctx.receive()).input;
    return await Promise.all([
      ctx.agent("workflow-marker", {
        message: `${service}:replica-0`,
      }),
      ctx.agent("workflow-marker", {
        message: `${service}:replica-1`,
      }),
    ]);
  },
});
