import type { RuntimeActionResult } from "#shared/action-types.js";
import type { CallRow } from "#protocol/session-projection/tables.js";
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
 * A call as the session's tables hold it, such as `ctx.view.calls[event.data.callId]` in a
 * `call.settled` hook. Absent rows match nothing.
 */
export type SettledCallRow = Pick<CallRow, "callId" | "capability" | "outcome" | "output">;

/** What {@link toolResultFrom} matches: a client's action result or a settled call's row. */
export type ToolResultSource = RuntimeActionResult | SettledCallRow | undefined;

/**
 * Overloaded signature for {@link toolResultFrom}.
 */
export interface ToolResultFromFn {
  <TInput, TOutput>(
    result: ToolResultSource,
    tool: ToolDefinition<TInput, TOutput>,
  ): MatchedToolResult<TOutput> | undefined;

  (
    result: ToolResultSource,
    connection: McpClientConnectionDefinition,
  ): MatchedConnectionResult | undefined;
}

/**
 * Narrows a {@link RuntimeActionResult}, or a settled call's row from the session's tables, to a
 * typed tool or connection result by matching against an authored definition object.
 *
 * Pass a `ToolDefinition` to get a typed `output`; pass a
 * `McpClientConnectionDefinition` to match any tool from that
 * connection (`output` stays `unknown`).
 *
 * Returns `undefined` when the result doesn't match, when `isError` is `true`, or when the call
 * didn't complete.
 *
 * ```ts
 * "call.settled"(event, ctx) {
 *   const match = toolResultFrom(ctx.view.calls[event.data.callId], weather);
 * }
 * ```
 */
export const toolResultFrom: ToolResultFromFn = toolResultFromImpl;

/** The tool name and output of a completed tool call, from either source. */
function completedToolCall(
  source: ToolResultSource,
): { readonly callId: string; readonly output: unknown; readonly toolName: string } | undefined {
  if (source === undefined) return undefined;
  if ("capability" in source) {
    if (source.capability.kind !== "tool" || source.outcome !== "completed") return undefined;
    return { callId: source.callId, output: source.output, toolName: source.capability.name };
  }
  if (source.kind !== "tool-result" || source.isError === true) return undefined;
  return { callId: source.callId, output: source.output, toolName: source.toolName };
}

function toolResultFromImpl<TInput, TOutput>(
  result: ToolResultSource,
  tool: ToolDefinition<TInput, TOutput>,
): MatchedToolResult<TOutput> | undefined;
function toolResultFromImpl(
  result: ToolResultSource,
  connection: McpClientConnectionDefinition,
): MatchedConnectionResult | undefined;
function toolResultFromImpl(
  source: ToolResultSource,
  definition: ToolDefinition<unknown, unknown> | McpClientConnectionDefinition,
): MatchedToolResult<unknown> | MatchedConnectionResult | undefined {
  const result = completedToolCall(source);
  if (result === undefined) return undefined;

  const entry = readDefinitionSource(definition);
  if (entry === undefined) return undefined;
  if (entry.kind === "ambiguous") return undefined;

  if (entry.kind === "tool") {
    if (!entry.names.has(result.toolName)) return undefined;
    return {
      callId: result.callId,
      output: result.output,
      toolName: result.toolName,
    };
  }

  for (const name of entry.names) {
    const prefix = name + CONNECTION_TOOL_SEPARATOR;
    if (!result.toolName.startsWith(prefix)) continue;
    return {
      callId: result.callId,
      connectionToolName: result.toolName.slice(prefix.length),
      output: result.output,
      toolName: result.toolName,
    };
  }
  return undefined;
}
