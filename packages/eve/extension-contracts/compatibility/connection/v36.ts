import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 36 `turn.waiting` events had no `awaitingPerson`; epoch 37 adds it as optional.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
