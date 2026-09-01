import type { RuntimeActionResult } from "#shared/action-types.js";
import type { McpClientConnectionDefinition } from "#public/definitions/connections/mcp.js";
import { readDefinitionSource } from "#internal/authored-definition/source-identity.js";
import type { ToolDefinition } from "#tools/definition.js";

/**
 * Narrowed tool result returned by {@link toolResultFrom} when the
 * action result matches an authored {@link ToolDefinition}.
 *
 * `TOutput` is inferred from the tool definition's `execute` return type.
 */
export interface MatchedToolResult<TOutput> {
  readonly callId: string;
  readonly output: TOutput;
  readonly toolName: string;
}

/**
 * Narrowed tool result returned by {@link toolResultFrom} when the
 * action result matches an MCP connection.
 *
 * `output` stays `unknown` because MCP tool schemas are remote.
 * `connectionToolName` is the unqualified MCP tool name (e.g.
 * `"list_issues"`) while `toolName` is the full qualified name
 * (e.g. `"linear__list_issues"`).
 */
export interface MatchedConnectionResult {
  readonly callId: string;
  readonly connectionToolName: string;
  readonly output: unknown;
  readonly toolName: string;
}

const CONNECTION_TOOL_SEPARATOR = "__";

/**
 * Overloaded signature for {@link toolResultFrom}.
 */
export interface ToolResultFromFn {
  <TInput, TOutput>(
    result: RuntimeActionResult,
    tool: ToolDefinition<TInput, TOutput>,
  ): MatchedToolResult<TOutput> | undefined;

  (
    result: RuntimeActionResult,
    connection: McpClientConnectionDefinition,
  ): MatchedConnectionResult | undefined;
}

/**
 * Narrows a {@link RuntimeActionResult} to a typed tool or connection
 * result by matching against an authored definition object.
 *
 * Pass a `ToolDefinition` to get a typed `output`; pass a
 * `McpClientConnectionDefinition` to match any tool from that
 * connection (`output` stays `unknown`).
 *
 * Returns `undefined` when the result doesn't match, or when
 * `isError` is `true`.
 */
export const toolResultFrom: ToolResultFromFn = toolResultFromImpl;

function toolResultFromImpl<TInput, TOutput>(
  result: RuntimeActionResult,
  tool: ToolDefinition<TInput, TOutput>,
): MatchedToolResult<TOutput> | undefined;
function toolResultFromImpl(
  result: RuntimeActionResult,
  connection: McpClientConnectionDefinition,
): MatchedConnectionResult | undefined;
function toolResultFromImpl(
  result: RuntimeActionResult,
  source: ToolDefinition<unknown, unknown> | McpClientConnectionDefinition,
): MatchedToolResult<unknown> | MatchedConnectionResult | undefined {
  if (result.kind !== "tool-result") return undefined;
  if (result.isError === true) return undefined;

  const entry = readDefinitionSource(source);
  if (entry === undefined) return undefined;
  if (entry.kind === "ambiguous") return undefined;

  if (entry.kind === "tool") {
    if (result.toolName !== entry.name) return undefined;
    return {
      callId: result.callId,
      output: result.output,
      toolName: result.toolName,
    };
  }

  const prefix = entry.name + CONNECTION_TOOL_SEPARATOR;
  if (!result.toolName.startsWith(prefix)) return undefined;
  return {
    callId: result.callId,
    connectionToolName: result.toolName.slice(prefix.length),
    output: result.output,
    toolName: result.toolName,
  };
}
