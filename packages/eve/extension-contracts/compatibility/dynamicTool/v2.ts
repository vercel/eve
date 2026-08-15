import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => ({
      inspect_session: defineTool({
        description: "Inspect the current session",
        inputSchema: { type: "object", properties: {} },
        async execute(_input, toolContext) {
          const sandbox = await toolContext.getSandbox();
          return {
            resolverSessionId: ctx.session.id,
            sandboxAvailable: sandbox !== undefined,
            sessionId: toolContext.session.id,
          };
        },
      }),
    }),
  },
});
