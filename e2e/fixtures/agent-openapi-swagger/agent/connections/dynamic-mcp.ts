import { defineDynamic, defineMcpClientConnection, once } from "eve/connections";

export default defineDynamic({
  select: once,
  render: () =>
    defineMcpClientConnection({
      description: "Caller-specific dynamic MCP service.",
      url: "https://dynamic-mcp.example.invalid/mcp",
    }),
});
