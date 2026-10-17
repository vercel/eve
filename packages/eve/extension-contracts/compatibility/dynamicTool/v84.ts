import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 84 failed tool results carried only the error message; epoch 85 adds
// an optional `errorName`. Dynamic tools that throw keep failing the same way.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ({
      quota: defineTool({
        description: "Return the active session's remaining quota.",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          throw new Error(`Quota exhausted for session ${ctx.session.id}`);
        },
      }),
    }),
  },
});
