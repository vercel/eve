import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 81 re-declares the reasoning level type to exclude the AI SDK's new `max`
// level, so the accepted levels stay the same. Dynamic tools don't set reasoning.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => ({
      model_id: defineTool({
        description: "Return the active model identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ modelId: ctx.model?.id ?? null }),
      }),
    }),
  },
});
