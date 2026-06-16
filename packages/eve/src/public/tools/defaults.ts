/**
 * Framework-provided tool definitions exposed as plain {@link ToolDefinition}
 * values so authors can spread, wrap, or patch them inside their own
 * `agent/tools/*.ts` files.
 */
import { BASH_TOOL_DEFINITION } from "#runtime/framework-tools/bash.js";
import { GLOB_TOOL_DEFINITION } from "#runtime/framework-tools/glob.js";
import { GREP_TOOL_DEFINITION } from "#runtime/framework-tools/grep.js";
import { READ_FILE_TOOL_DEFINITION } from "#runtime/framework-tools/read-file.js";
import { SKILL_TOOL_DEFINITION } from "#runtime/framework-tools/skill.js";
import { TODO_TOOL_DEFINITION } from "#runtime/framework-tools/todo.js";
import { WEB_FETCH_TOOL_DEFINITION } from "#runtime/framework-tools/web-fetch.js";
import { WEB_SEARCH_TOOL_DEFINITION } from "#runtime/framework-tools/web-search.js";
import { WRITE_FILE_TOOL_DEFINITION } from "#runtime/framework-tools/write-file.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { toPublicToolDefinition } from "#public/tools/internal.js";

export type { ToolDefinition };

/**
 * Framework-provided shell execution tool. Spread or wrap to customize.
 */
export const bash: ToolDefinition = toPublicToolDefinition(BASH_TOOL_DEFINITION);

/**
 * Framework-provided file search tool. Finds files by glob pattern. Spread
 * or wrap to customize.
 */
export const glob: ToolDefinition = toPublicToolDefinition(GLOB_TOOL_DEFINITION);

/**
 * Framework-provided content search tool. Searches file contents by regex
 * pattern. Spread or wrap to customize.
 */
export const grep: ToolDefinition = toPublicToolDefinition(GREP_TOOL_DEFINITION);

/**
 * Framework-provided file reader tool (`read_file`). Spread or wrap to
 * customize. The framework resets the durable read-before-write stamps on
 * context compaction automatically, regardless of how the reader is defined.
 */
export const readFile: ToolDefinition = toPublicToolDefinition(READ_FILE_TOOL_DEFINITION);

/**
 * Framework-provided file writer tool. Spread or wrap to customize.
 * Enforces read-before-write for existing files and stale-read detection.
 */
export const writeFile: ToolDefinition = toPublicToolDefinition(WRITE_FILE_TOOL_DEFINITION);

/**
 * Framework-provided HTTP fetch tool. Spread or wrap to customize.
 */
export const webFetch: ToolDefinition = toPublicToolDefinition(WEB_FETCH_TOOL_DEFINITION);

/**
 * Framework-provided durable todo list tool. Spreading the default keeps its
 * closure-bound state behavior: the executor still reads and writes the
 * framework's internal todo state. Replace with a fully custom executor (and
 * your own `ContextKey`) if you need different state semantics.
 */
export const todo: ToolDefinition = toPublicToolDefinition(TODO_TOOL_DEFINITION);

/**
 * Framework-provided skill loading tool (`load_skill`). Reads a named skill's
 * instructions from the sandbox and returns them as the tool result. It is
 * only useful when the agent declares skills: with no skills available the
 * framework does not surface skill descriptions to the model, so the model has
 * nothing to load.
 */
export const loadSkill: ToolDefinition = toPublicToolDefinition(SKILL_TOOL_DEFINITION);

/**
 * Framework-provided web search tool. The provider manages the real
 * implementation; the harness injects it at step time based on the model
 * provider. The local `execute` here is a throwing stub: calling it directly
 * fails. To run your own search instead, replace this with `defineTool()` in
 * `agent/tools/web_search.ts`.
 *
 * This default has no input schema (`inputSchema` is empty): the
 * provider-managed implementation defines its own contract at step time, so it
 * is shaped differently from the others, which preserve their real schemas.
 */
export const webSearch: ToolDefinition = {
  description: WEB_SEARCH_TOOL_DEFINITION.description,
  inputSchema: {} as never,
  execute(_input) {
    throw new Error(
      "web_search is provider-managed and has no local execute. " +
        "Override with defineTool() to provide a custom implementation.",
    );
  },
};
