import {
  defineDynamic,
  defineTool,
  type DynamicToolEvents,
  type DynamicToolResult,
} from "#public/tools/index.js";

/**
 * Epoch 4 resolvers take the stream event as `unknown` — `meta.id` predates
 * epoch 5 — and shape model-facing output with `toModelOutput`.
 */
const events = {
  "session.started": (_event, ctx): DynamicToolResult => ({
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
  "step.started": (): DynamicToolResult => null,
} satisfies DynamicToolEvents;

export default defineDynamic({ events });
