// Epoch 95 workflow tools can continue opening agent sessions without options.
import { defineWorkflowTool } from "#public/tools/index.js";

export default defineWorkflowTool({
  description: "Ask the reviewer to inspect a deployment.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const response = await ctx.agent("reviewer").send("Review the deployment.");
    return await response.result();
  },
});
