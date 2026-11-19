import type { Attributes } from "./types.js";
import type { ContentSerializer } from "./types.js";

/** MCP request details to record on the active span, such as the connection, method, session, and response status. */
export interface McpUpdate {
  readonly connectionName?: string;
  readonly method?: string;
  readonly toolName?: string;
  readonly protocolVersion?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly statusCode?: string | number;
}

/** Records an MCP request's metadata, arguments, result, and error on its span, honoring the capture decision. */
export interface McpLifecycle {
  update(input: McpUpdate): void;
  error(error?: unknown, type?: string): void;
  arguments(value: unknown): void;
  result(value: unknown): void;
}

/** Creates an {@link McpLifecycle} that writes MCP and GenAI attributes through `write`, recording arguments and results only when the capture allows inputs or outputs. */
export function mcpLifecycle(input: {
  readonly write: (attributes: Attributes) => void;
  readonly error: (error?: unknown, type?: string) => void;
  readonly serializer: ContentSerializer;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}): McpLifecycle {
  return {
    update(update) {
      if (update.connectionName !== undefined && update.method !== undefined)
        input.write({
          "agent.connection.name": update.connectionName,
          "mcp.method.name": update.method,
          "network.protocol.name": "http",
          "network.transport": "tcp",
          "mcp.protocol.version": update.protocolVersion,
          "jsonrpc.request.id": update.requestId,
          "gen_ai.operation.name": update.method === "tools/call" ? "execute_tool" : undefined,
          "gen_ai.tool.name": update.method === "tools/call" ? update.toolName : undefined,
        });
      if (update.sessionId !== undefined) input.write({ "mcp.session.id": update.sessionId });
      if (update.statusCode !== undefined)
        input.write({ "rpc.response.status_code": update.statusCode });
    },
    error(error, type) {
      input.error(
        input.recordOutputs ? error : undefined,
        type ?? (error instanceof Error ? error.name : undefined),
      );
    },
    arguments(value) {
      if (input.recordInputs)
        input.write({ "gen_ai.tool.call.arguments": input.serializer.json(value) });
    },
    result(value) {
      if (input.recordOutputs)
        input.write({ "gen_ai.tool.call.result": input.serializer.json(value) });
    },
  };
}
