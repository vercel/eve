import { defineTool } from "#public/tools/index.js";

// Epoch 85 `turn.failed` events had no `terminal`; epoch 86 adds it as optional.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  execute: (input) => ({ id: (input as { readonly id: string }).id }),
});
