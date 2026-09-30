import { defineTool } from "#public/tools/index.js";

// Epoch 66 `task.settled` events had no `name` or `kind`; epoch 67 adds both
// as optional. Tools that never read task events keep working.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  execute: (input) => ({ id: (input as { readonly id: string }).id }),
});
