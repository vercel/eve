import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  url: "https://example.com/mcp",
  description: "Example MCP service",
});
