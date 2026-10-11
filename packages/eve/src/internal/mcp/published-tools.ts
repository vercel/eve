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
import { isJsonObjectValue, type JsonValue } from "#shared/json.js";
import { isObject } from "#shared/guards.js";

/** Extension a client declares to join tool sessions with `_meta["dev.eve/tool-session"]`. */
export const MCP_TOOL_SESSIONS_EXTENSION = "dev.eve/tool-sessions";
/** `_meta` key carrying a `tools/call`'s tool session key. */
export const MCP_TOOL_SESSION_META_KEY = "dev.eve/tool-session";

const log = createLogger("mcp.tools");
const warnedReserved = new Set<string>();

/**
 * The agent's invocable tools as MCP tools. Each `tools/call` runs the tool
 * through `invokeTool` as `principals`: the route-authenticated caller, or the
 * user a trusted forwarder named. Tools named like one in `reserved` are
 * skipped, since the channel serves that name itself.
 */
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
            // The verified forwarder scopes a keyed session, so two routers
            // that name the same user do not share a sandbox.
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

/**
 * The call's tool session key. It is honoured only from a client that
 * declared the extension in this request's capabilities; any other client,
 * including every 2025-era client, gets a one-off session whatever its
 * `_meta` carries. `invokeTool` checks the key's length.
 */
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
