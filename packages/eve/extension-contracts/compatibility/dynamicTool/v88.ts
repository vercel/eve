import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 88 model options had no `maxOutputTokens`; epoch 89 adds it as an optional field, which is additive.
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
