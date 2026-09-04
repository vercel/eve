import type { Approval } from "#approval/definition.js";
import type { DynamicResolveContext, DynamicToolEventName } from "#dynamic/definition.js";
import type {
  PublicToolInputSchema,
  PublicToolOutputSchema,
  ToolLabelDefinition,
  ToolContext,
} from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";
import type { ToolModelOutput } from "#tools/model-output.js";

/**
 * A single tool entry within a resolved dynamic tool set.
 *
 * Identity comes from context: a single returned entry is named after
 * the file slug; entries in a returned `Record<string, DynamicToolEntry>`
 * are each named `slug__key`.
 *
 * `TInput` defaults to `Record<string, unknown>` but is inferred when
 * `inputSchema` is a Standard Schema (e.g. Zod) via the `defineTool`
 * wrapper. `TOutput` defaults to `any`; provide an `outputSchema`
 * (Standard Schema) to infer and check the executor return type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DynamicToolEntry<TInput = Record<string, unknown>, TOutput = any> {
  readonly label?: ToolLabelDefinition<TInput, TOutput>;
  readonly description: string;
  readonly inputSchema: PublicToolInputSchema<TInput>;
  readonly outputSchema?: PublicToolOutputSchema<TOutput>;
  readonly execution?: "background";
  execute(input: TInput, ctx: ToolContext, task?: TaskExec): TOutput | Promise<TOutput>;
  readonly toModelOutput?: (output: TOutput) => ToolModelOutput | Promise<ToolModelOutput>;
  /**
   * Optional per-call approval gate, mirroring the authored-tool
   * `approval` contract: return `"user-approval"` to require user approval
   * before the call executes. Dynamic approval request and response callbacks
   * use the same durable descriptor boundary as `execute` and `toModelOutput`.
   */
  readonly approval?: Approval;
}

/**
 * A resolved tool set: keys are entry identifiers, values are
 * {@link DynamicToolEntry} objects created via `defineTool` inside a
 * resolver. Entry type params are `any` so entries with differing
 * schemas stay assignable to one Record; `defineTool` captures each
 * entry's concrete types before this widened container.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DynamicToolSet = Readonly<Record<string, DynamicToolEntry<any, any>>>;

/**
 * Return type for a `defineDynamic` event handler: a single tool entry
 * (named after the file slug), a map of entries (named `slug__key`), or
 * `null` for no tools.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DynamicToolResult = DynamicToolEntry<any, any> | DynamicToolSet | null;

/**
 * Strongly-typed tool-handler map: each key is a supported event name,
 * each value a resolver that takes the stream event and resolve context
 * and returns a {@link DynamicToolResult}. `defineDynamic` accepts the
 * wider {@link DynamicEvents} (handlers return `unknown`) because the
 * slot directory (tools/ vs skills/) decides the expected return at
 * runtime. Reference `DynamicToolEvents` to check the tool-specific
 * return type at authoring time.
 */
export type DynamicToolEvents = {
  readonly [K in DynamicToolEventName]?: (
    event: unknown,
    ctx: DynamicResolveContext,
  ) => DynamicToolResult | Promise<DynamicToolResult>;
};

/**
 * Symbol-based brand stamped by `defineTool` on every entry. Invisible
 * in IntelliSense, checked at runtime to enforce the wrapper and to
 * distinguish a single entry from a map of entries.
 */
export const TOOL_BRAND = Symbol.for("eve:tool-brand");

/**
 * Returns true if `value` carries the `defineTool` brand symbol. Used
 * to detect single entry vs map of entries and to validate that entries
 * are properly wrapped.
 */
export function isBrandedToolEntry(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[TOOL_BRAND] === true
  );
}
