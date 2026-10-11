import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 70 `turn.started` had no `continuesTurnId`, and calls had no `cancelled` status; both
// are additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineTool({
        description: "Return the active session identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
  },
});
