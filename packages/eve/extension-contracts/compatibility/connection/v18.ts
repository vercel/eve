import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  auth: {
    getToken: async () => ({ token: "fixture-token" }),
    principalType: "user",
  },
  description: "Search support cases.",
  url: "https://support.example.com/mcp",
});
