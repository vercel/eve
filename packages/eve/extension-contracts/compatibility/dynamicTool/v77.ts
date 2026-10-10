import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 77 callbacks that do not inspect a replacement predecessor remain supported.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ({
      session: defineTool({
        deferred: true,
        description: "Return the active session identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
    }),
  },
});
