import { defineDynamic, defineMcpClientConnection } from "#public/connections/index.js";

export const support = defineMcpClientConnection({
  description: "Search support cases",
  url: "https://support.example.com/mcp",
  auth: { getToken: async () => ({ token: "fixture-token" }) },
});

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineMcpClientConnection({
        description: "Search tenant support cases",
        url: "https://support.example.com/mcp",
        instanceKey: ctx.session.id,
        headers: { "X-Session": ctx.session.id },
      }),
  },
});
