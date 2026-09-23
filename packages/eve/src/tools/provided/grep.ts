import { type GrepInput, executeGrepOnSandbox } from "#execution/sandbox/grep-tool.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface GrepToolInput {
  context?: number;
  glob?: string;
  ignoreCase?: boolean;
  limit?: number;
  literal?: boolean;
  path?: string;
  pattern: string;
}

export interface GrepToolOutput {
  content: string;
  matchCount: number;
  path: string;
  truncated: boolean;
}

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
      maximum: 1000,
      description: "Maximum number of matches to return per file. Defaults to 100.",
    },
    literal: {
      type: "boolean",
      description:
        "Treat the pattern as a literal string instead of a regular expression. Defaults to false.",
    },
    path: {
      type: "string",
      description:
        "The directory or file to search in. Defaults to /workspace. " +
        "Must be an absolute path or begin with $HOME/. Omit to use the default.",
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
    path: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["content", "matchCount", "path", "truncated"],
  additionalProperties: false,
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const grep: ToolDefinition<GrepToolInput, GrepToolOutput> = defineTool({
  label: { start: (input) => toolLabel("Search", input.pattern) },
  description: [
    "Fast content search tool that works with any codebase size.",
    "",
    "Usage:",
    "- Searches file contents using regular expressions.",
    '- Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+").',
    '- Filter files by pattern with the glob parameter (e.g. "*.js", "*.{ts,tsx}").',
    "- Returns matching lines with file paths and line numbers.",
    "- Call this tool in parallel when you have multiple independent searches.",
    "- Any line longer than 2000 characters is truncated.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeGrepOnSandbox(await ctx.getSandbox(), input as GrepInput);
  },
  inputSchema: GREP_INPUT_SCHEMA,
  outputSchema: GREP_OUTPUT_SCHEMA,
});

export default grep;
