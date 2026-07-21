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
  }),
} satisfies DynamicToolEvents;

export default defineDynamic({ events });
