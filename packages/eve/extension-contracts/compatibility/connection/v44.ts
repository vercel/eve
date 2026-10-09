import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 44 skill loads named their skill only in the action's `input`, and a
// `load-skill-result` might omit `name`; epoch 45 adds `name` to `load-skill`
// requests and requires it on results.
export default defineMcpClientConnection({
  description: "Search the incident tracker.",
  url: "https://incidents.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
