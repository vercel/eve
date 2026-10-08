import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 75 had no `history` option or `history.imported` event; epoch 76 adds both, which is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineTool({
        description: "Report the current session.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ sessionId: ctx.session.id }),
      }),
  },
});
