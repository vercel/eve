import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 81 reached the v26 stream event types through client results; epoch 82 replaces
// them with v27 session events. Dynamic tools that don't read session events keep working.
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
