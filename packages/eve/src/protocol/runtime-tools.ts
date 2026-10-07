import { CATALOG_TOOL_NAMES } from "#protocol/catalog-tools.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#protocol/final-output-tool.js";
import { TASK_TOOL_NAMES } from "#protocol/task-tools.js";

/** The tools eve adds to sessions itself, each with the role that reserving its name protects. */
const RUNTIME_TOOL_ROLES: ReadonlyMap<string, string> = new Map([
  ...CATALOG_TOOL_NAMES.map((name) => [name, "catalog tool"] as const),
  ...TASK_TOOL_NAMES.map((name) => [name, "task tool"] as const),
  [FINAL_OUTPUT_TOOL_NAME, "final output tool"],
]);

/** The names no tool, subagent, or connection may take, authored or dynamic. */
export const RUNTIME_TOOL_NAMES: readonly string[] = [...RUNTIME_TOOL_ROLES.keys()];

/** What eve reserves `name` for, such as "catalog tool", or undefined when the name is free. */
export function runtimeToolRole(name: string): string | undefined {
  return RUNTIME_TOOL_ROLES.get(name);
}
