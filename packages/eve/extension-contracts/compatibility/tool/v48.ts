import { defineWorkflowTool } from "#public/tools/index.js";

export default defineWorkflowTool({
  description: "Ask the existing research subagent for a summary.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    "use workflow";
    return await ctx.agent("research", { message: "Summarize Alice's trip options." });
  },
});
