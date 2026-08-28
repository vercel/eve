import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Return the current tool call identity.",
  inputSchema: { type: "object" },
  execute: async (_input, ctx) => ({ callId: ctx.callId, toolName: ctx.toolName }),
});
