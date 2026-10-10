import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Specialist tools.",
  url: "https://specialist.example.test/eve/v1/mcp",
  protocolVersionDiscovery: false,
  approval: ({ session }) => (session.auth.current === null ? "denied" : "user-approval"),
});
