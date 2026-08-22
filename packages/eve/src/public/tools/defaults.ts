/**
 * Framework-provided tool definitions exposed as plain {@link ToolDefinition}
 * values so authors can spread, wrap, or patch them inside their own
 * `agent/tools/*.ts` files.
 */
import { loadSkillToolDefinition } from "#runtime/framework-tools/skill.js";
import {
  TODO_INPUT_SCHEMA,
  TODO_OUTPUT_SCHEMA,
  executeTodoTool,
  type TodoToolInput,
} from "#runtime/framework-tools/todo.js";
import {
  WEB_FETCH_INPUT_SCHEMA,
  WEB_FETCH_OUTPUT_SCHEMA,
} from "#runtime/framework-tools/web-fetch.js";
import { executeWebFetchTool, type WebFetchInput } from "#execution/web-fetch/tool.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { defineBashTool } from "#public/tools/define-bash-tool.js";
import { defineGlobTool } from "#public/tools/define-glob-tool.js";
import { defineGrepTool } from "#public/tools/define-grep-tool.js";
import { defineReadFileTool } from "#public/tools/define-read-file-tool.js";
import { defineWriteFileTool } from "#public/tools/define-write-file-tool.js";

export type { ToolDefinition };

/**
 * Framework-provided shell execution tool. Spread or wrap to customize.
 */
export const bash: ToolDefinition = defineBashTool({
  description: "Execute a shell command in the shared workspace environment.",
});

/**
 * Framework-provided file search tool. Finds files by glob pattern. Spread
 * or wrap to customize.
 */
export const glob: ToolDefinition = defineGlobTool();

/**
 * Framework-provided content search tool. Searches file contents by regex
 * pattern. Spread or wrap to customize.
 */
export const grep: ToolDefinition = defineGrepTool();

/**
 * Framework-provided file reader tool (`read_file`). Spread or wrap to
 * customize. The framework resets the durable read-before-write stamps on
 * context compaction automatically, regardless of how the reader is defined.
 */
export const readFile: ToolDefinition = defineReadFileTool({
  description: [
    "Read a file from the local filesystem. If the path does not exist, an error is returned.",
    "",
    "Usage:",
    "- The filePath parameter should be an absolute path or begin with $HOME/.",
    "- By default, this tool returns up to 2000 lines from the start of the file.",
    "- The offset parameter is the line number to start from (1-indexed).",
    "- To read later sections, call this tool again with a larger offset.",
    '- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n".',
    "- Any line longer than 2000 characters is truncated.",
    "- Call this tool in parallel when you know there are multiple files you want to read.",
    "- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.",
  ].join("\n"),
});

/**
 * Framework-provided file writer tool. Spread or wrap to customize.
 * Enforces read-before-write for existing files and stale-read detection.
 */
export const writeFile: ToolDefinition = defineWriteFileTool({
  description: [
    "Writes a file to the local filesystem.",
    "",
    "Usage:",
    "- This tool will overwrite the existing file if there is one at the provided path.",
    "- If this is an existing file, you MUST use the read_file tool first to read the file's contents. This tool will fail if you did not read the file first.",
    "- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.",
    "- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.",
    "- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
  ].join("\n"),
});

/**
 * Framework-provided HTTP fetch tool. Spread or wrap to customize.
 */
export const webFetch: ToolDefinition = {
  description: [
    "Fetch a webpage and return its content in the requested format. Use this to retrieve and analyze content from URLs.",
    "",
    "Usage notes:",
    "- The URL must be a fully-formed valid URL starting with https://",
    "- HTML responses are automatically converted to markdown or plain text based on the requested format",
    '- Format options: "markdown" (default), "text", or "html"',
    "- Default timeout is 30 seconds (max 120 seconds)",
    "- Maximum response size is 5 MB; content is further capped at the shared tool-output budget (50 KB / 2000 lines)",
    "- This tool is read-only and does not modify any files",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeWebFetchTool(input as WebFetchInput, { abortSignal: ctx.abortSignal });
  },
  inputSchema: WEB_FETCH_INPUT_SCHEMA,
  outputSchema: WEB_FETCH_OUTPUT_SCHEMA,
};

/**
 * Framework-provided durable todo list tool. Spreading the default keeps its
 * closure-bound state behavior: the executor still reads and writes the
 * framework's internal todo state. Replace with a fully custom executor (and
 * your own `ContextKey`) if you need different state semantics.
 */
export const todo: ToolDefinition = {
  description: [
    "Use this tool to create and manage a structured task list for the current session.",
    "This helps you track progress, organize complex tasks, and demonstrate thoroughness.",
    "",
    "When to use:",
    "- Complex multistep tasks requiring 3 or more distinct steps",
    "- When the user provides multiple tasks or a numbered list",
    "- After receiving new instructions, to capture requirements",
    "- After completing a task, to mark it complete and add follow-ups",
    "",
    "When NOT to use:",
    "- Single, straightforward tasks that need no tracking",
    "- Purely conversational or informational requests",
    "",
    "Usage:",
    "- Call with `todos` to replace the entire list (full replacement write)",
    "- Call without `todos` to read the current list",
    "- Both return the full current list with status counts",
    "- Mark tasks in_progress when you start, completed when done",
    "- Only have ONE task in_progress at a time",
  ].join("\n"),
  async execute(input) {
    return executeTodoTool((input ?? {}) as TodoToolInput);
  },
  inputSchema: TODO_INPUT_SCHEMA,
  outputSchema: TODO_OUTPUT_SCHEMA,
};

/**
 * Framework-provided skill loading tool (`load_skill`). Returns a named
 * authored skill's instructions directly; dynamic skills remain sandbox-backed.
 * It is only useful when the agent declares skills: with no skills available the
 * framework does not surface skill descriptions to the model, so the model has
 * nothing to load.
 */
export const loadSkill: ToolDefinition = loadSkillToolDefinition;
