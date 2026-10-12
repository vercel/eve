import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 49 moves dynamic values and hooks to select, record, render, and run. Connections
// that don't define dynamic values keep working.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
