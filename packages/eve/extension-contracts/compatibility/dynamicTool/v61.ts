import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 61 tool contexts had no `messages`; it is additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineTool({
        description: "Return the active session identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: (_input, toolCtx) => ({ callId: toolCtx.callId, sessionId: ctx.session.id }),
      }),
  },
});
