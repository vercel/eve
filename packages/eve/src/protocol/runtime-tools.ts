import { CATALOG_TOOL_NAMES } from "#protocol/catalog-tools.js";
import { FINAL_OUTPUT_TOOL_NAME } from "#protocol/final-output-tool.js";
import { TASK_TOOL_NAMES } from "#protocol/task-tools.js";

/**
 * The tools eve adds to sessions itself, each with the role that reserving its
 * name protects. No tool, subagent, or connection may take one of these names,
 * authored or dynamic.
 */
const RUNTIME_TOOL_ROLES: ReadonlyMap<string, string> = new Map([
  ...CATALOG_TOOL_NAMES.map((name) => [name, "catalog tool"] as const),
  ...TASK_TOOL_NAMES.map((name) => [name, "task tool"] as const),
  [FINAL_OUTPUT_TOOL_NAME, "final output tool"],
]);

/**
 * Why `name` is taken, such as `eve reserves "search" for its built-in catalog
 * tool`, for errors to quote; undefined when the name is free.
 */
export function runtimeToolReservation(name: string): string | undefined {
  const role = RUNTIME_TOOL_ROLES.get(name);
  return role === undefined ? undefined : `eve reserves "${name}" for its built-in ${role}`;
}
