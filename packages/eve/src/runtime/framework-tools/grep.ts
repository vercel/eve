import { executeGrepOnSandbox, type GrepInput } from "#execution/sandbox/grep-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { JsonObject } from "#shared/json.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Shared input schema used by the framework `grep` tool and any author tool
 * constructed via {@link defineGrepTool}.
 *
 * Exported so the public `defineGrepTool` factory and the framework
 * `GREP_TOOL_DEFINITION` use the exact same schema object — keeping model
 * input contracts in sync without duplication.
 */
export const GREP_INPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    context: {
      description:
        "Number of surrounding context lines to include before and after each match. Defaults to 0.",
      minimum: 0,
      type: "integer",
    },
    glob: {
      description: 'Filter files by glob pattern (e.g. "*.ts", "*.{ts,tsx}").',
      type: "string",
    },
    ignoreCase: {
      description: "Perform case-insensitive search. Defaults to false.",
      type: "boolean",
    },
    limit: {
      description: "Maximum number of matches to return per file. Defaults to 100.",
      maximum: 1000,
      minimum: 1,
      type: "integer",
    },
    literal: {
      description:
        "Treat the pattern as a literal string instead of a regular expression. Defaults to false.",
      type: "boolean",
    },
    path: {
      description:
        "The directory or file to search in. Defaults to /workspace. " +
        "Must be an absolute path. Omit to use the default.",
      type: "string",
    },
    pattern: {
      description:
        'The regex pattern to search for in file contents (e.g. "log.*Error", "function\\s+\\w+").',
      type: "string",
    },
  },
  required: ["pattern"],
  type: "object",
};

/**
 * Shared output schema used by the framework `grep` tool and any author tool
 * constructed via {@link defineGrepTool}.
 */
export const GREP_OUTPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    content: { type: "string" },
    matchCount: { type: "integer" },
    path: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["content", "matchCount", "path", "truncated"],
  type: "object",
};

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
async function executeGrep(input: unknown): Promise<unknown> {
  return executeGrepOnSandbox(await requireSandboxSession(), input as GrepInput);
}

export const GREP_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Fast content search tool that works with any codebase size.",
    "",
    "Usage:",
    "- Searches file contents using regular expressions.",
    '- Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+").',
    '- Filter files by pattern with the glob parameter (e.g. "*.js", "*.{ts,tsx}").',
    "- Returns matching lines with file paths and line numbers.",
    "- Use this tool when you need to find files containing specific patterns.",
    "- Use the glob tool instead if you only need to find files by name.",
    "- Call this tool in parallel when you have multiple independent searches.",
    "- Any line longer than 2000 characters is truncated.",
  ].join("\n"),
  execute: executeGrep,
  inputSchema: GREP_INPUT_SCHEMA,
  logicalPath: "eve:framework/grep",
  name: "grep",
  outputSchema: GREP_OUTPUT_SCHEMA,
  sourceId: "eve:grep-tool",
  sourceKind: "module",
};
