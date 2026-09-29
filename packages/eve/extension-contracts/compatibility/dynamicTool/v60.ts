import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 60 tool-call action requests had no `parentCallId`; epoch 61 adds it as optional.
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
