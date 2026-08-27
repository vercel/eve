import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Call-aware MCP service",
  toolCall: {
    providedArguments: {
      requestId: ({ callId, session, toolName }) => `${session.id}:${toolName}:${callId}`,
    },
  },
  url: "https://example.com/mcp",
});
