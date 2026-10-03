import { fromJsonSchema } from "#compiled/@modelcontextprotocol/server/index.js";

import type { AgentToolDescription } from "#channel/agent-description.js";
import type { InvokeToolFn, InvokeToolResult } from "#channel/invoke-tool.js";
import { createLogger } from "#internal/logging.js";
import {
  defineMcpTool,
  McpToolOperationError,
  type McpCallToolResult,
  type McpServerTool,
} from "#internal/mcp/streamable-http-server.js";
import { isJsonObjectValue, type JsonValue } from "#shared/json.js";

const log = createLogger("mcp.tools");
const warnedReserved = new Set<string>();

/**
 * The agent's invocable tools as MCP tools. Each `tools/call` runs the tool
 * through `invokeTool` as the route-authenticated caller. Tools named like
 * one in `reserved` are skipped, since the channel serves that name itself.
 */
export function createPublishedTools(input: {
  readonly invokeTool: InvokeToolFn;
  readonly reserved: ReadonlySet<string>;
  readonly tools: readonly AgentToolDescription[];
}): McpServerTool[] {
  return input.tools
    .filter((tool) => {
      if (!input.reserved.has(tool.name)) return true;
      if (!warnedReserved.has(tool.name)) {
        warnedReserved.add(tool.name);
        log.warn(
          `mcpChannel does not publish the tool "${tool.name}": the channel serves that name.`,
        );
      }
      return false;
    })
    .map((tool) =>
      defineMcpTool({
        definition: {
          description: tool.description,
          inputSchema: fromJsonSchema(tool.inputSchema),
          name: tool.name,
          outputSchema:
            tool.outputSchema === undefined ? undefined : fromJsonSchema(tool.outputSchema),
        },
        async call(value, { auth, signal }) {
          if (auth === null) {
            throw new McpToolOperationError("denied", "The channel authenticated no caller.");
          }
          const result = await input.invokeTool(tool.name, value, { auth, signal });
          return toCallToolResult(tool.name, result, tool.outputSchema !== undefined);
        },
      }),
    );
}

function toCallToolResult(
  name: string,
  result: InvokeToolResult,
  hasOutputSchema: boolean,
): McpCallToolResult<JsonValue> {
  switch (result.status) {
    case "completed": {
      const output = result.output as JsonValue;
      const text =
        result.modelOutput.type === "text"
          ? result.modelOutput.value
          : JSON.stringify(output ?? null);
      // A declared outputSchema obliges structured content of any JSON type: the
      // SDK rejects a result without it and wraps non-objects as `{ result }` on
      // 2025 connections. Without a schema, only objects are structured.
      return hasOutputSchema || isJsonObjectValue(output)
        ? { content: [{ text, type: "text" }], structuredContent: output ?? null }
        : { content: [{ text, type: "text" }] };
    }
    case "invalid-input":
      throw new McpToolOperationError("invalid_input", result.message);
    case "denied":
      throw new McpToolOperationError(
        "denied",
        result.reason ?? `The tool "${name}" was denied by its approval policy.`,
      );
    case "approval-required":
      throw new McpToolOperationError(
        "approval_required",
        `The tool "${name}" needs a person's approval, which this MCP channel cannot ask for. Call it from a conversation instead.`,
      );
    case "authorization-required":
      throw new McpToolOperationError(
        "authorization_required",
        `The tool "${name}" needs a sign-in to ${result.connections.join(", ")}, which this MCP channel cannot ask for. Sign in from a conversation, then call it again.`,
      );
    case "failed":
      throw new McpToolOperationError("internal", result.message);
  }
}
