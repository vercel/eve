import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 45 reached the v26 stream event types through client results; epoch 46 replaces
// them with v27 session events. Connections that don't read session events keep working.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
