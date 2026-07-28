import {
  defineDynamic,
  defineTool,
  type DynamicToolEvents,
  type DynamicToolResult,
} from "#public/tools/index.js";

/**
 * Epoch 3 resolvers take the stream event as `unknown` and read session
 * identity from the resolve context.
 */
const events = {
  "session.started": (_event, ctx): DynamicToolResult => ({
    inspect_session: defineTool({
      description: "Inspect the resolved session",
      inputSchema: { type: "object", properties: {} },
      async execute(_input, toolContext) {
        return {
          resolverSessionId: ctx.session.id,
          toolSessionId: toolContext.session.id,
        };
      },
    }),
  }),
  "step.started": (): DynamicToolResult => null,
} satisfies DynamicToolEvents;

export default defineDynamic({ events });
