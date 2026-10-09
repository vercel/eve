import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 46 approval policies that decide without the server's tool annotations remain supported.
export default defineMcpClientConnection({
  description: "Manage issues in the tracker.",
  url: "https://tracker.example.com/mcp",
  approval({ toolInput, toolName }) {
    return toolName.endsWith("__delete_issue") && toolInput !== undefined
      ? "user-approval"
      : "not-applicable";
  },
});
