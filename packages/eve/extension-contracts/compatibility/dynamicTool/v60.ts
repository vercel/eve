import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 60 authorization events had no `principalId`; it is additive.
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
