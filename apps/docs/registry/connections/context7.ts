import { defineMcpClientConnection } from "eve/connections";

const apiKey = process.env.CONTEXT7_API_KEY;

export default defineMcpClientConnection({
  url: "https://mcp.context7.com/mcp",
  description: "Context7: up-to-date, version-specific library documentation and code examples.",
  ...(apiKey
    ? {
        auth: {
          getToken: async () => ({ token: apiKey }),
        },
      }
    : {}),
  tools: {
    allow: ["resolve-library-id", "query-docs"],
  },
});
