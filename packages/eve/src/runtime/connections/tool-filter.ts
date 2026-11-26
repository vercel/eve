import type { ToolFilterDefinition } from "#shared/connection-types.js";

export function passesToolFilter(
  names: readonly string[],
  filter: Readonly<ToolFilterDefinition> | undefined,
): boolean {
  if (filter === undefined) {
    return true;
  }
  if ("allow" in filter) {
    return names.some((name) => filter.allow.includes(name));
  }
  return !names.some((name) => filter.block.includes(name));
}
