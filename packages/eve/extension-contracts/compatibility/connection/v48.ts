import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 48 `action.result` errors had no `name`; epoch 49 adds it as optional.
export default defineMcpClientConnection({
  description: "Manage issues in the tracker.",
  url: "https://tracker.example.com/mcp",
});
