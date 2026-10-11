import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 34 `task.settled` events had no `name` or `kind`; epoch 35 adds both as optional.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
