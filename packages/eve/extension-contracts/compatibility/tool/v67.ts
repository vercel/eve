import { defineTool } from "#public/tools/index.js";

// Epoch 67 had no `serializeModelInputSchema` export; epoch 68 adds it.
// Tools with plain JSON input schemas keep working.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  execute: (input) => ({ id: (input as { readonly id: string }).id }),
});
