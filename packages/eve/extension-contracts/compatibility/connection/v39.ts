import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 39 MCP connections had no `forwardPrincipal`; epoch 40 adds it.
// Connections that authenticate with their own headers keep working.
export default defineMcpClientConnection({
  description: "The specialist agent's tools.",
  url: "https://specialist.example.com/eve/v1/mcp",
  headers: { authorization: "Bearer specialist-token" },
  protocolVersionDiscovery: false,
});
