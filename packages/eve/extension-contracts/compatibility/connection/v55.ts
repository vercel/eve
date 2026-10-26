// Epoch 55 of the connection capability. Epoch 56 changes only the sandbox session types it reaches
// (eve-owned declarations plus `writeFiles`); connection authoring is unchanged, as this example shows.
import { defineDynamic, defineMcpClientConnection } from "#public/connections/index.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineMcpClientConnection({
        description: "Read Alice's support queue.",
        url: "https://support.example.com/mcp",
        headers: { "X-Session": ctx.session.id },
      }),
  },
});
