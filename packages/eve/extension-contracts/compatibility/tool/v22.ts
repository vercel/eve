import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Return the active tool identity.",
  inputSchema: { type: "object", properties: {} },
  execute(_input, ctx) {
    return { callId: ctx.callId, toolName: ctx.toolName };
  },
});
