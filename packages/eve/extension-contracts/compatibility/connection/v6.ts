import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Tenant-aware MCP service",
  toolCall: {
    providedArguments: {
      tenantId: ({ session, toolName }) => `${session.id}:${toolName}`,
    },
  },
  url: "https://example.com/mcp",
});
