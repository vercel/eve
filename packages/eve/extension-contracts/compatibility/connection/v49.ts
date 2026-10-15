import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 49 Connect providers carry connector metadata without an events bridge.
export default defineMcpClientConnection({
  description: "Read issues from the tracker.",
  url: "https://tracker.example.com/mcp",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: "service-credential" }),
    vercelConnect: { connector: "oauth/issues" },
  },
});
