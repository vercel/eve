import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 29 approval events carried no taskId; epoch 30 adds it for approvals
// proxied from a child task. Connection options are unchanged.
export default defineMcpClientConnection({
  description: "Manage deployments for the release team.",
  url: "https://deploy.example.com/mcp",
  approval({ toolName }) {
    return toolName.startsWith("list") ? "approved" : "user-approval";
  },
});
