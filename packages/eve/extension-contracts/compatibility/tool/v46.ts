import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Report whether the current tool execution was cancelled.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute(_input, ctx) {
    return { cancelled: ctx.abortSignal?.aborted ?? false };
  },
});
