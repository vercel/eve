import { fromJsonSchema } from "#compiled/@modelcontextprotocol/server/index.js";

import type { AgentToolDescription } from "#channel/agent-description.js";
import type { InvokeToolFn, InvokeToolResult } from "#channel/invoke-tool.js";
import { createLogger } from "#internal/logging.js";
import type { McpRequestPrincipals } from "#internal/mcp/forwarded-principal-header.js";
import {
  defineMcpTool,
  McpToolOperationError,
  type McpCallToolResult,
  type McpServerTool,
  type McpToolCallContext,
} from "#internal/mcp/streamable-http-server.js";
import type { ToolModelOutput } from "#tools/model-output.js";
import { isJsonObjectValue, type JsonValue } from "#shared/json.js";
import { isObject } from "#shared/guards.js";

export const MCP_TOOL_SESSIONS_EXTENSION = "dev.eve/tool-sessions";
export const MCP_TOOL_SESSION_META_KEY = "dev.eve/tool-session";

const log = createLogger("mcp.tools");
const warnedReserved = new Set<string>();

export function createPublishedTools(input: {
  readonly invokeTool: InvokeToolFn;
  readonly principals: McpRequestPrincipals;
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
        async call(value, context) {
          const { current, forwarder, initiator } = input.principals;
          const key = toolSessionKey(context);
          const result = await input.invokeTool(tool.name, value, {
            auth: current,
            forwardedBy: forwarder,
            initiator,
            key,
            signal: context.signal,
          });
          return toCallToolResult(tool.name, result, tool.outputSchema !== undefined);
        },
      }),
    );
}

function toolSessionKey(context: McpToolCallContext): string | undefined {
  const declared = context.clientCapabilities;
  const extensions = isObject(declared) ? declared.extensions : undefined;
  if (!isObject(extensions) || !isObject(extensions[MCP_TOOL_SESSIONS_EXTENSION])) {
    return undefined;
  }
  const key = context.meta?.[MCP_TOOL_SESSION_META_KEY];
  if (key === undefined || typeof key === "string") return key;
  throw new McpToolOperationError(
    "invalid_input",
    `_meta["${MCP_TOOL_SESSION_META_KEY}"] must be a string.`,
  );
}

function modelOutputText(modelOutput: ToolModelOutput): string {
  switch (modelOutput.type) {
    case "text":
    case "error-text":
      return modelOutput.value;
    case "json":
      return JSON.stringify(modelOutput.value ?? null);
    case "content":
      return modelOutput.value.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
}

function toCallToolResult(
  name: string,
  result: InvokeToolResult,
  hasOutputSchema: boolean,
): McpCallToolResult<JsonValue> {
  switch (result.outcome) {
    case "completed": {
      const output = result.output as JsonValue;
      const { modelOutput } = result;
      const isError = modelOutput.type === "error-text";
      const text = modelOutputText(modelOutput);
      const content = [{ text, type: "text" as const }];
      const structured =
        hasOutputSchema || isJsonObjectValue(output)
          ? { content, structuredContent: output ?? null }
          : { content };
      return isError ? { ...structured, isError: true } : structured;
    }
    case "rejected":
      if (result.cause !== undefined) throw new McpToolOperationError("denied", result.reason);
      if (result.reason === "approval-required")
        throw new McpToolOperationError(
          "approval_required",
          `The tool "${name}" needs a person's approval, which this MCP channel cannot ask for. Call it from a conversation instead.`,
        );
      if (result.reason === "sign-in-required")
        throw new McpToolOperationError(
          "authorization_required",
          `The tool "${name}" needs a sign-in to ${result.connections?.join(", ") ?? "its connections"}, which this MCP channel cannot ask for. Sign in from a conversation, then call it again.`,
        );
      throw new McpToolOperationError("denied", result.reason);
    case "failed":
      throw new McpToolOperationError(
        result.error.code === "INVALID_INPUT" ? "invalid_input" : "internal",
        result.error.message,
      );
  }
}
