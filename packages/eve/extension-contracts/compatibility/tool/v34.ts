import { z } from "zod";

import { defineWorkflowTool } from "#public/tools/index.js";

export default defineWorkflowTool({
  description: "Review a deployment.",
  inputSchema: z.object({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";
    return await ctx.agent("researcher", {
      message: `Review the ${service} deployment.`,
      outputSchema: {
        properties: {
          findings: { items: { type: "string" }, type: "array" },
        },
        required: ["findings"],
        type: "object",
      },
    });
  },
});
