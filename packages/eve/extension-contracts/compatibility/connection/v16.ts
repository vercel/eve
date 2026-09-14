import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Call-aware MCP service",
  url: "https://example.com/mcp",
});
