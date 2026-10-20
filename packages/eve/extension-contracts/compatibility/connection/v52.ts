import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Read reports from the tracker.",
  url: "https://tracker.example.com/mcp",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: "service-credential" }),
  },
});
