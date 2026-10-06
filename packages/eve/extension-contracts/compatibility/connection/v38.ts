import { defineDynamic, defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 38 re-exported `DynamicResolveContext` with `model: { id } | null`;
// epoch 39 types it as `AgentModelSelection`, which keeps `id`. Connection
// resolvers never received `model`, so they keep working unchanged.
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineMcpClientConnection({
        description: "Search the incident tracker.",
        url: "https://incidents.example.com/mcp",
        headers: { "X-Session": ctx.session.id },
      }),
  },
});
