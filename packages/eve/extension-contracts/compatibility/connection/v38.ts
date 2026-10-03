import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 38 MCP connections had no `forwardPrincipal`; epoch 39 adds it.
// Connections that authenticate with their own headers keep working.
export default defineMcpClientConnection({
  description: "The specialist agent's tools.",
  url: "https://specialist.example.com/eve/v1/mcp",
  headers: { authorization: "Bearer specialist-token" },
  protocolVersionDiscovery: false,
});
