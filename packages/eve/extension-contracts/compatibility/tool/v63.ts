import { defineTool } from "#public/tools/index.js";

// Epoch 63 tool-call action requests had no `parentCallId`; epoch 64 adds it
// as optional for nested actions. Approval policies keep reading the same fields.
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
