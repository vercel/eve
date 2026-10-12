import { defineTool } from "#public/tools/index.js";

// Epoch 86 reached the v26 stream event types through client results; epoch 87 replaces
// them with v27 session events. Tools that don't read session events keep working.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  execute: (input) => ({ id: (input as { readonly id: string }).id }),
});
