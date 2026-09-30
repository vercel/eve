import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 65 `turn.failed` events had no `terminal`; epoch 66 adds it as optional.
export default defineDynamic({
  events: {
    "turn.started": () => ({
      session_id: defineTool({
        description: "Return the current session id.",
        inputSchema: { type: "object", properties: {} },
        execute: (_input, ctx) => ctx.session.id,
      }),
    }),
  },
});
