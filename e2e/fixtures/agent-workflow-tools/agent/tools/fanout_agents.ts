import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Call two workflow-owned subagents in parallel and return both inline results.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    return await Promise.all([
      ctx.agent({
        key: "replica-0",
        message: `${service}:replica-0`,
        target: "workflow-marker",
      }),
      ctx.agent({
        key: "replica-1",
        message: `${service}:replica-1`,
        target: "workflow-marker",
      }),
    ]);
  },
});
