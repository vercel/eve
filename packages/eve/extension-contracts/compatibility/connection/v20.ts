import { defineDynamic, defineMcpClientConnection } from "#public/connections/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineMcpClientConnection({
            description: "Read the authenticated support queue.",
            url: "https://support.example.com/mcp",
          }),
  },
});
