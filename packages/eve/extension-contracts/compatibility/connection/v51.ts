// Epoch 51 of the connection capability: the authoring contract of epoch 50 still compiles.
// Epoch 52 adds an optional `windows` usage field to subagent results.
import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Read issues from the tracker.",
  url: "https://tracker.example.com/mcp",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: "service-credential" }),
    vercelConnect: { connector: "oauth/issues" },
  },
});
