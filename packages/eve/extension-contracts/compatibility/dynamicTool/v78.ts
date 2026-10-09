import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 79 adds an optional `promptCache` to the `modelOptions` a dynamic model
// selection can return, which reaches this capability through `auto`'s result
// type. Dynamic tools don't return model selections.
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
