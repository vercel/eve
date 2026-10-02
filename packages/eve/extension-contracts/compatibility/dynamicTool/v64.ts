import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 64 `task.settled` events had no `name` or `kind`; epoch 65 adds both as optional.
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
