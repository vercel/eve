import {
  defineDynamic,
  defineTool,
  type DynamicToolEvents,
  type ToolContext,
} from "#public/tools/index.js";

const events = {
  "session.started": (_event, resolve) => ({
    inspect_request: defineTool({
      description: "Report the request-scoped session and channel context",
      inputSchema: { type: "object" },
      execute: async (_input, ctx: ToolContext) => ({
        aborted: ctx.abortSignal.aborted,
        callId: ctx.callId,
        channel: resolve.channel.kind ?? "unknown",
        sessionId: resolve.session.id,
        toolName: ctx.toolName,
      }),
    }),
    inspect_session: defineTool({
      description: "Inspect the current session",
      inputSchema: { type: "object", properties: {} },
      async execute(_input, toolContext: ToolContext) {
        const sandbox = await toolContext.getSandbox();
        return {
          resolverSessionId: resolve.session.id,
          sandboxAvailable: sandbox !== undefined,
          sessionId: toolContext.session.id,
        };
      },
    }),
  }),
} satisfies DynamicToolEvents;

export default defineDynamic({ events });
