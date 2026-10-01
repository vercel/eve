import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 35 `task.settled` events had no `cancel`; epoch 36 adds it as optional.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
