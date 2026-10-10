import { defineDynamic, defineMcpClientConnection } from "eve/connections";

export default defineDynamic({
  select: () => null,
  resolve: () =>
    defineMcpClientConnection({
      description: "Caller-specific dynamic MCP service.",
      url: "https://dynamic-mcp.example.invalid/mcp",
    }),
});
