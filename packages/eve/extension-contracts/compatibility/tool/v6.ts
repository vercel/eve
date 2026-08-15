import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Summarize a completed task.",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, ctx) {
    return { callId: ctx.callId, summary: "Task completed." };
  },
  toModelOutput(output) {
    return { type: "text", value: output.summary };
  },
});
