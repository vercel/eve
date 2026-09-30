import { defineTool } from "#public/tools/index.js";

// Epoch 68 `turn.failed` events had no `terminal`; epoch 69 adds it as optional.
// Approval policies keep reading the same fields.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  approval: ({ toolName, toolInput }) =>
    toolName === "lookup_order" && typeof toolInput?.id === "string"
      ? "not-applicable"
      : "user-approval",
  execute: (input) => ({ id: (input as { readonly id: string }).id }),
});
