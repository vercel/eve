import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 79 adds an optional `promptCache` to the resolver context's model
// reference. A dynamic tool that reads only the model id is unaffected.
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
