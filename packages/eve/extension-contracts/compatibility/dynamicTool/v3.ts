import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => ({
      summarize_report: defineTool({
        description: "Summarize a report for the model",
        inputSchema: { type: "object", properties: {} },
        async execute(_input, toolContext) {
          return {
            internal: "details",
            resolverSessionId: ctx.session.id,
            sessionId: toolContext.session.id,
            summary: "Report generated",
          };
        },
        toModelOutput(output) {
          return {
            type: "text",
            value: (output as { summary: string }).summary,
          };
        },
      }),
    }),
  },
});
