import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 37 `turn.waiting` events had no `on`; epoch 38 adds it.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
