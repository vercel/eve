import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 43 had no `history` option or `history.imported` event; epoch 44 adds both, which is additive.
export default defineMcpClientConnection({
  description: "Specialist tools.",
  url: "https://specialist.example.test/eve/v1/mcp",
  protocolVersionDiscovery: false,
  approval: ({ session }) => (session.auth.current === null ? "denied" : "user-approval"),
});
