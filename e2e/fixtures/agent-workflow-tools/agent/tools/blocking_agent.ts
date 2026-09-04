import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Run one subagent from a waiting workflow tool.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    return await ctx.agent({
      key: "blocking-child",
      message: `${service}:blocking`,
      target: "workflow-marker",
    });
  },
});
