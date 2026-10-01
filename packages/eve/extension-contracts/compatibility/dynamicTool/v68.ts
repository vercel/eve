import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 68 `session.waiting`, `session.failed`, `session.completed`, and `turn.waiting` events had no `usage`; epoch 69 adds it as optional.
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
