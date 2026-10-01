import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 36 sessions had no `task.activity` event; epoch 37 adds it.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
