import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 41 tool-call action requests could carry `parentCallId` for nested
// actions; epoch 42 drops it, since connection tools no longer report them.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
