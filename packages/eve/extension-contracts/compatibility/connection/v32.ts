import { defineDynamic, defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 32 authorization events had no `principalId`; it is additive.
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
