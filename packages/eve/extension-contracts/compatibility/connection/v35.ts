import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 35 `turn.failed` events had no `terminal`; epoch 36 adds it as optional.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
