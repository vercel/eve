import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Stream report progress.",
  inputSchema: { type: "object", properties: {} },
  async *execute(_input, ctx) {
    yield { callId: ctx.callId, phase: "collecting" };
    yield { callId: ctx.callId, phase: "complete" };
  },
  toModelOutput(output) {
    return { type: "text", value: output.phase };
  },
});
