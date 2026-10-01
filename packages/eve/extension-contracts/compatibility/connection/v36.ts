import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 36 `session.waiting`, `session.failed`, and `session.completed` events had no `usage`; epoch 37 adds it as optional.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
