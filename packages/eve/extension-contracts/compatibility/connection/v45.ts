import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 45 callbacks that do not inspect a replacement predecessor remain supported.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
