import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 57 approval events carried no taskId; epoch 58 adds it for approvals
// proxied from a child task. Tool definitions and contexts are unchanged.
export default defineDynamic({
  events: {
    "session.started": () => ({
      session_id: defineTool({
        description: "Return the current session id.",
        inputSchema: { type: "object", properties: {} },
        execute: (_input, ctx) => ctx.session.id,
      }),
    }),
  },
});
