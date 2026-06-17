import type { RuntimeActionResult } from "#runtime/actions/types.js";
import type { McpClientConnectionDefinition } from "#public/definitions/connections/mcp.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

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

/**
 * Discriminated source entry stamped on authored definitions during
 * agent resolution via {@link stampDefinitionSource}.
 */
type DefinitionSourceEntry =
  | { readonly kind: "connection"; readonly logicalPath?: string; readonly name: string }
  | { readonly kind: "tool"; readonly logicalPath?: string; readonly name: string };

type AmbiguousDefinitionSourceEntry = { readonly kind: "ambiguous" };

/**
 * Cross-instance symbol for reading the stable definition key stamped
 * by `defineTool` / `defineMcpClientConnection`, then replaced with a
 * source-derived key by the resolver when source metadata is available.
 * `Symbol.for` ensures both the resolution pipeline's module copy and
 * the user's import share the same property key.
 */
const DEFINITION_KEY = Symbol.for("eve.definition-source-key");

/**
 * Global registry mapping definition keys to their resolved runtime
 * names. Rooted on `globalThis` via `Symbol.for` so every module
 * copy shares one registry — same pattern as `context/key.ts`
 * (`KEY_REGISTRY_GLOBAL_KEY`).
 */
const REGISTRY_SYMBOL = Symbol.for("eve.definition-source-registry");

type DefinitionSourceRegistry = Map<string, DefinitionSourceEntry | AmbiguousDefinitionSourceEntry>;

type RegistryGlobal = typeof globalThis & {
  [REGISTRY_SYMBOL]?: DefinitionSourceRegistry;
};

const registryContainer = globalThis as RegistryGlobal;

if (registryContainer[REGISTRY_SYMBOL] === undefined) {
  registryContainer[REGISTRY_SYMBOL] = new Map();
}

const definitionSourceRegistry = registryContainer[REGISTRY_SYMBOL];

/**
 * Stamps a stable key on the definition so it can be identified across
 * module instances. Definition helpers first stamp an authoring-time
 * fallback key; the resolver overwrites it with a source-derived key.
 */
export function stampDefinitionKey(definition: object, key: string): void {
  Object.defineProperty(definition, DEFINITION_KEY, { configurable: true, value: key });
}

/**
 * Reads the stable key from a definition, or `undefined` if unstamped.
 */
function readDefinitionKey(definition: object): string | undefined {
  if (DEFINITION_KEY in definition) {
    return (definition as Record<symbol, string>)[DEFINITION_KEY];
  }
  return undefined;
}

/**
 * Registers a definition key → source entry mapping in the global
 * registry. Called by the resolution pipeline after loading the
 * authored module.
 */
export function registerDefinitionSource(key: string, entry: DefinitionSourceEntry): void {
  const existing = definitionSourceRegistry.get(key);
  if (existing !== undefined && !sameDefinitionSourceEntry(existing, entry)) {
    if (existing.kind !== "ambiguous") {
      console.warn(
        [
          `eve could not assign a unique toolResultFrom identity for ${JSON.stringify(key)}.`,
          `Conflicting definitions: ${formatDefinitionSourceForWarning(existing)} and ${formatDefinitionSourceForWarning(entry)}.`,
          "Multiple authored definitions share that fallback identity, so toolResultFrom will not match through it.",
          "Use the original definition object loaded by eve so source-derived identity can be used instead.",
        ].join(" "),
      );
    }
    definitionSourceRegistry.set(key, { kind: "ambiguous" });
    return;
  }
  definitionSourceRegistry.set(key, entry);
}

function sameDefinitionSourceEntry(
  a: DefinitionSourceEntry | AmbiguousDefinitionSourceEntry,
  b: DefinitionSourceEntry,
): boolean {
  if (a.kind !== b.kind) return false;
  return a.name === b.name;
}

function formatDefinitionSourceForWarning(entry: DefinitionSourceEntry): string {
  if (entry.logicalPath === undefined) {
    return `${entry.kind} "${entry.name}"`;
  }
  return `${entry.kind} "${entry.name}" from "${entry.logicalPath}"`;
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

  const key = readDefinitionKey(source);
  if (key === undefined) return undefined;

  const entry = definitionSourceRegistry.get(key);
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
