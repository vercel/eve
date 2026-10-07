/**
 * A connection owns its name and every name under its `<name>__` prefix, so a
 * catalog name under that prefix always means one of the connection's tools.
 * Names are compared as written; a connection's tools are never listed to
 * check them.
 */

import { FINAL_OUTPUT_TOOL_NAME } from "#harness/final-output.js";
import { CATALOG_TOOL_NAMES } from "#protocol/catalog-tools.js";
import { TASK_TOOL_NAMES } from "#protocol/task-tools.js";

/**
 * The tools eve adds to sessions itself. A connection's own name is the entry
 * that signs the user in to it, so no connection may take one of these.
 */
export const RUNTIME_TOOL_NAMES: readonly string[] = [
  ...CATALOG_TOOL_NAMES,
  ...TASK_TOOL_NAMES,
  FINAL_OUTPUT_TOOL_NAME,
];

/** The full name of a connection tool: `linear__list_issues`. */
export function connectionToolName(connectionName: string, toolName: string): string {
  return `${connectionName}__${toolName}`;
}

/** The connection that owns `name`, if any. */
function owningConnection(name: string, connectionNames: Iterable<string>): string | undefined {
  for (const connection of connectionNames) {
    if (name === connection || name.startsWith(connectionToolName(connection, ""))) {
      return connection;
    }
  }
  return undefined;
}

/**
 * Throws when `name` belongs to one of `connectionNames`. `subject` names the
 * rejected entry, such as `Dynamic tool`, and `remedy` says how to fix it.
 */
export function assertNotConnectionOwned(input: {
  readonly connectionNames: Iterable<string>;
  readonly name: string;
  readonly remedy: string;
  readonly subject: string;
}): void {
  const connection = owningConnection(input.name, input.connectionNames);
  if (connection === undefined) return;
  const conflict =
    input.name === connection
      ? `has the same name as connection "${connection}"`
      : `starts with "${connection}__", which belongs to connection "${connection}"`;
  throw new Error(`${input.subject} "${input.name}" ${conflict}. ${input.remedy}`);
}
