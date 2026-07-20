import { z } from "#compiled/zod/index.js";

import { executeGrepOnSandbox, type GrepInput } from "#execution/sandbox/grep-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Shared input schema used by the framework `grep` tool and any author tool
 * constructed via {@link defineGrepTool}.
 *
 * Exported so the public `defineGrepTool` factory and the framework
 * `GREP_TOOL_DEFINITION` use the exact same schema object — keeping model
 * input contracts in sync without duplication.
 */
export const GREP_INPUT_SCHEMA = z.strictObject({
  context: z
    .number()
    .int()
    .min(0)
    .describe(
      "Number of surrounding context lines to include before and after each match. Defaults to 0.",
    )
    .optional(),
  glob: z.string().describe('Filter files by glob pattern (e.g. "*.ts", "*.{ts,tsx}").').optional(),
  ignoreCase: z
    .boolean()
    .describe("Perform case-insensitive search. Defaults to false.")
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .describe("Maximum number of matches to return per file. Defaults to 100.")
    .optional(),
  literal: z
    .boolean()
    .describe(
      "Treat the pattern as a literal string instead of a regular expression. Defaults to false.",
    )
    .optional(),
  path: z
    .string()
    .describe(
      "The directory or file to search in. Defaults to /workspace. " +
        "Must be an absolute path. Omit to use the default.",
    )
    .optional(),
  pattern: z
    .string()
    .describe(
      'The regex pattern to search for in file contents (e.g. "log.*Error", "function\\s+\\w+").',
    ),
});

/**
 * Shared output schema used by the framework `grep` tool and any author tool
 * constructed via {@link defineGrepTool}.
 */
export const GREP_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  matchCount: z.number().int(),
  path: z.string(),
  truncated: z.boolean(),
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
async function executeGrep(input: unknown, options?: ToolExecuteOptions): Promise<unknown> {
  return executeGrepOnSandbox(
    await requireSandboxSession(options?.abortSignal),
    input as GrepInput,
  );
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
