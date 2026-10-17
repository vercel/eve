import { defineDynamic as baseDefineDynamic, type DynamicSentinel } from "#dynamic/definition.js";
import type { DynamicToolEvents, DynamicToolResult } from "#tools/dynamic.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
/** A tool resolver may return only tools, named tool sets, or null. */
export function defineDynamic<const TEvents extends DynamicToolEvents>(definition: {
  readonly events: ExactDefinition<TEvents, DynamicToolEvents>;
}): DynamicSentinel<DynamicToolResult> {
  return baseDefineDynamic(definition) as DynamicSentinel<DynamicToolResult>;
}
