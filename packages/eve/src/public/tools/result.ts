import type { CallRow } from "#protocol/session-projection/tables.js";
import type { McpClientConnectionDefinition } from "#public/definitions/connections/mcp.js";
import type { OpenAPIConnectionDefinition } from "#public/definitions/connections/openapi.js";
import { readDefinitionSource } from "#internal/authored-definition/source-identity.js";
import type { ToolDefinition } from "#tools/definition.js";

/**
 * Narrowed tool result returned by {@link toolResultFrom} when the
 * settled call matches an authored {@link ToolDefinition}.
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
 * settled call matches an MCP or OpenAPI connection.
 *
 * `output` stays `unknown` because connection tool schemas are remote.
 * `connectionToolName` is the unqualified connection tool name (e.g.
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

type ConnectionDefinition = McpClientConnectionDefinition | OpenAPIConnectionDefinition;

/**
 * A call as the session's tables hold it, such as `ctx.view.calls[event.data.callId]` in a
 * `call.settled` hook. Absent rows match nothing.
 */
export type SettledCallRow = Pick<CallRow, "callId" | "capability" | "outcome" | "output">;

/** What {@link toolResultFrom} matches: a settled call's row, or nothing. */
export type ToolResultSource = SettledCallRow | undefined;

/**
 * Overloaded signature for {@link toolResultFrom}.
 */
export interface ToolResultFromFn {
  <TInput, TOutput>(
    result: ToolResultSource,
    tool: ToolDefinition<TInput, TOutput>,
  ): MatchedToolResult<TOutput> | undefined;

  (result: ToolResultSource, connection: ConnectionDefinition): MatchedConnectionResult | undefined;
}

/**
 * Narrows a settled call's row from the session's tables to a typed tool or connection result by
 * matching against an authored definition object.
 *
 * Pass a `ToolDefinition` to get a typed `output`; pass an MCP or OpenAPI
 * connection definition to match any tool from that connection (`output`
 * stays `unknown`).
 *
 * Returns `undefined` when the call doesn't match, isn't a tool's, or
 * didn't complete.
 *
 * ```ts
 * "call.settled"(event, ctx) {
 *   const match = toolResultFrom(ctx.view.calls[event.data.callId], weather);
 * }
 * ```
 */
export const toolResultFrom: ToolResultFromFn = toolResultFromImpl;

/** The tool name and output of a completed tool call. */
function completedToolCall(
  source: ToolResultSource,
): { readonly callId: string; readonly output: unknown; readonly toolName: string } | undefined {
  if (source?.capability.kind !== "tool" || source.outcome !== "completed") return undefined;
  return { callId: source.callId, output: source.output, toolName: source.capability.name };
}

function toolResultFromImpl<TInput, TOutput>(
  result: ToolResultSource,
  tool: ToolDefinition<TInput, TOutput>,
): MatchedToolResult<TOutput> | undefined;
function toolResultFromImpl(
  result: ToolResultSource,
  connection: ConnectionDefinition,
): MatchedConnectionResult | undefined;
function toolResultFromImpl(
  source: ToolResultSource,
  definition: ToolDefinition<unknown, unknown> | ConnectionDefinition,
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
