import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Summarize a report for the model",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, ctx) {
    return {
      internal: "details",
      sessionId: ctx.session.id,
      summary: "Report generated",
    };
  },
  toModelOutput(output) {
    return {
      type: "text",
      value: (output as { summary: string }).summary,
    };
  },
});
