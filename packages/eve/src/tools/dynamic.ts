import {
  defineDynamic as defineDynamicDefinition,
  type DefineDynamic,
} from "#dynamic/definition.js";
import type { ToolDefinition } from "#tools/definition.js";

/**
 * One tool a dynamic resolver returns, created with `defineTool()`. A single returned entry is
 * named after the file; entries of a returned map are named by their keys, prefixed with the
 * mount namespace for an extension's resolver.
 */
export type DynamicToolEntry = Pick<ToolDefinition, "description" | "inputSchema">;

/** A map of dynamic tools, named by key. */
export type DynamicToolSet = Readonly<Record<string, DynamicToolEntry>>;

/** What a dynamic tool resolver returns: one tool, a map of them, or `null`. */
export type DynamicToolResult = DynamicToolEntry | DynamicToolSet | null;

/** `defineDynamic()` for `agent/tools/`: `resolve` returns tools. */
export const defineDynamic: DefineDynamic<DynamicToolResult> = defineDynamicDefinition;

/**
 * Symbol-based brand stamped by `defineTool` on every entry. Invisible
 * in IntelliSense, checked at runtime to enforce the wrapper and to
 * distinguish a single entry from a map of entries.
 */
export const TOOL_BRAND = Symbol.for("eve:tool-brand");

/** True when `value` carries the `defineTool` brand. */
export function isBrandedToolEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[TOOL_BRAND] === true
  );
}
