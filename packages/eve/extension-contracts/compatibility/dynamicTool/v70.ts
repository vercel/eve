import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 70 `ctx.model` was `{ id } | null`; epoch 71 makes it an
// `AgentModelSelection` that keeps `id`. Resolvers that read the id keep working.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ({
      model: defineTool({
        description: "Return the active model identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ modelId: ctx.model?.id ?? null }),
      }),
    }),
  },
});
