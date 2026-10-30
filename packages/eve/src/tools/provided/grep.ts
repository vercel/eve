import {
  executeGrepSearch,
  GREP_OUTPUT_MODES,
  type GrepToolInput,
  type GrepSearchResult as GrepToolOutput,
} from "#execution/sandbox/grep-search.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export type { GrepToolInput, GrepToolOutput };

/**
 * Input schema for the provided `grep` tool.
 */
export const GREP_INPUT_SCHEMA = defineJsonSchema<GrepToolInput>({
  type: "object",
  properties: {
    context: {
      type: "integer",
      minimum: 0,
      description:
        "Number of surrounding context lines to include before and after each match. Defaults to 0.",
    },
    glob: {
      type: "string",
      description: 'Filter files by glob pattern (e.g. "*.ts", "*.{ts,tsx}").',
    },
    ignoreCase: {
      type: "boolean",
      description: "Perform case-insensitive search. Defaults to false.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Maximum rows to return. Defaults to 50; capped at 200.",
    },
    literal: {
      type: "boolean",
      description:
        "Use a literal match. Defaults to true for identifier-like patterns, false for regex syntax.",
    },
    path: {
      type: "string",
      description:
        "Directory or file inside the workspace. Defaults to the workspace root. " +
        "Relative paths resolve within the workspace.",
    },
    outputMode: {
      type: "string",
      enum: GREP_OUTPUT_MODES,
      description:
        "files_with_matches (default) lists paths; content returns matching lines; count returns per-file totals.",
    },
    pattern: {
      type: "string",
      description:
        'The regex pattern to search for in file contents (e.g. "log.*Error", "function\\s+\\w+").',
    },
  },
  required: ["pattern"],
  additionalProperties: false,
});

/**
 * Output schema for the provided `grep` tool.
 */
export const GREP_OUTPUT_SCHEMA = defineJsonSchema<GrepToolOutput>({
  type: "object",
  properties: {
    content: { type: "string" },
    matchCount: { type: "integer" },
    outputMode: { type: "string", enum: GREP_OUTPUT_MODES },
    path: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["content", "matchCount", "outputMode", "path", "truncated"],
  additionalProperties: false,
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const grep: ToolDefinition<GrepToolInput, GrepToolOutput> = frameworkTool(
  defineTool({
    label: { start: (input) => toolLabel("Search", input.pattern) },
    description:
      "Search sandbox files with ripgrep (or a POSIX fallback). Start with files_with_matches and a narrow path or glob; use content for matching lines or count for totals. Includes hidden files, excludes .git; ripgrep respects .gitignore. The POSIX fallback does not read .gitignore. Output is bounded by rows and bytes.",
    async execute(input, ctx) {
      return await executeGrepSearch(input, await ctx.getSandbox(), ctx.abortSignal);
    },
    inputSchema: GREP_INPUT_SCHEMA,
    outputSchema: GREP_OUTPUT_SCHEMA,
  }),
);

export default grep;
import { frameworkTool } from "./framework-tool.js";
