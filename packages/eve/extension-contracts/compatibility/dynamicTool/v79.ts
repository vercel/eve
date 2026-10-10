import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 79 tool contexts had no `approval`; epoch 80 adds it as optional.
// Dynamic tools that read the session auth keep observing the requester.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ({
      requester: defineTool({
        deferred: true,
        description: "Return the active session's requester.",
        inputSchema: { type: "object", properties: {} },
        execute: (_input, toolContext) => ({
          sessionId: ctx.session.id,
          requester: toolContext.session.auth.current?.principalId ?? null,
        }),
      }),
    }),
  },
});
