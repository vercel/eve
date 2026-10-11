import { defineDynamic, defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 38 sign-ins didn't name the calls they stopped, and calls had no `cancelled` status;
// both are additive.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineMcpClientConnection({
            description: "Search the support knowledge base.",
            url: "https://support.example.com/mcp",
          }),
  },
});
