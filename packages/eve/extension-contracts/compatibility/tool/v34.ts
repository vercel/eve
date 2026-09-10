import { z } from "zod";
import { defineWorkflowTool } from "#public/tools/index.js";

export const workflow = defineWorkflowTool({
  description: "Ask a reviewer to summarize a report.",
  inputSchema: z.object({ report: z.string() }),
  async execute(input, ctx) {
    "use workflow";
    return await ctx.agent("reviewer", {
      message: `Review this report: ${input.report}`,
      outputSchema: {
        properties: { summary: { type: "string" } },
        required: ["summary"],
        type: "object",
      },
    });
  },
});
