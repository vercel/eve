import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 69 `turn.waiting` events had no `on`; epoch 70 adds it.
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
