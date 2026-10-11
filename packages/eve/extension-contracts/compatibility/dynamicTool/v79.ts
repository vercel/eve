import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 79 `turn.failed` events had no `terminal`; epoch 80 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ({
      session_id: defineTool({
        description: "Return the current session id.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
    }),
  },
});
