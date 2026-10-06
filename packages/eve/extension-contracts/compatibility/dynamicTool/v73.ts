import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 73 dynamic tool entries had no `deferred`; epoch 74 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ({
      session: defineTool({
        description: "Return the active session identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
    }),
  },
});
