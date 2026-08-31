import { defineDynamic, defineMcpClientConnection } from "#public/connections/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineMcpClientConnection({
        description: `MCP service for session ${ctx.session.id}`,
        url: "https://example.com/mcp",
      }),
  },
});
