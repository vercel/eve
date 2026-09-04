import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Run one subagent from a background workflow tool.",
  execution: "background",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    return await ctx.agent({
      key: "background-child",
      message: `${service}:background`,
      target: "workflow-marker",
    });
  },
});
