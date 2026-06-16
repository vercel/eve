import { ASK_QUESTION_TOOL_DEFINITION } from "#runtime/framework-tools/ask-question.js";
import { BASH_TOOL_DEFINITION } from "#runtime/framework-tools/bash.js";
import { GLOB_TOOL_DEFINITION } from "#runtime/framework-tools/glob.js";
import { GREP_TOOL_DEFINITION } from "#runtime/framework-tools/grep.js";
import { READ_FILE_TOOL_DEFINITION } from "#runtime/framework-tools/read-file.js";
import { SKILL_TOOL_DEFINITION } from "#runtime/framework-tools/skill.js";
import { TODO_TOOL_DEFINITION } from "#runtime/framework-tools/todo.js";
import { WEB_FETCH_TOOL_DEFINITION } from "#runtime/framework-tools/web-fetch.js";
import { WEB_SEARCH_TOOL_DEFINITION } from "#runtime/framework-tools/web-search.js";
import { WRITE_FILE_TOOL_DEFINITION } from "#runtime/framework-tools/write-file.js";

export { ConnectionRegistryKey } from "#context/providers/connection.js";
export type { ReadFileStamp, ReadFileState } from "#runtime/framework-tools/file-state.js";
export { ReadFileStateKey } from "#runtime/framework-tools/file-state.js";
export type { TodoItem, TodoState } from "#runtime/framework-tools/todo.js";
export { TodoStateKey } from "#runtime/framework-tools/todo.js";

import type { ResolvedToolDefinition } from "#runtime/types.js";

const ALL_FRAMEWORK_TOOLS: readonly ResolvedToolDefinition[] = [
  ASK_QUESTION_TOOL_DEFINITION,
  BASH_TOOL_DEFINITION,
  GLOB_TOOL_DEFINITION,
  GREP_TOOL_DEFINITION,
  READ_FILE_TOOL_DEFINITION,
  WRITE_FILE_TOOL_DEFINITION,
  TODO_TOOL_DEFINITION,
  WEB_FETCH_TOOL_DEFINITION,
  WEB_SEARCH_TOOL_DEFINITION,
  SKILL_TOOL_DEFINITION,
];

/**
 * Returns framework-owned tool definitions registered in the tool registry
 * alongside authored tools during graph resolution.
 *
 * `connection_search` is no longer in this list — it is registered as a
 * framework dynamic tool resolver in the graph resolution path.
 */
export function getFrameworkToolDefinitions(_config?: {
  readonly hasConnections?: boolean;
}): readonly ResolvedToolDefinition[] {
  return ALL_FRAMEWORK_TOOLS;
}

/**
 * Returns the names of every framework-provided tool the framework knows
 * about, regardless of whether the current agent gates any of them on
 * runtime configuration.
 *
 * Used by the graph resolver to validate `disableTool(name)` arguments —
 * disabling a name that does not match any known framework tool is treated
 * as an authoring error rather than silently dropping the request.
 */
export function getAllFrameworkToolNames(): ReadonlySet<string> {
  return new Set(ALL_FRAMEWORK_TOOLS.map((def) => def.name));
}
