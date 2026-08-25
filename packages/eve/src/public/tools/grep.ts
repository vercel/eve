import { z } from "#compiled/zod/index.js";

import { executeGrepOnSandbox, type GrepInput } from "#execution/sandbox/grep-tool.js";
import { defineTool } from "#public/definitions/tool.js";

/**
 * Input schema for the framework `grep` tool and any author tool constructed
 * via {@link defineGrepTool}. Single source of truth so model input contracts
 * stay in sync without duplication.
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
        "Must be an absolute path or begin with $HOME/. Omit to use the default.",
    )
    .optional(),
  pattern: z
    .string()
    .describe(
      'The regex pattern to search for in file contents (e.g. "log.*Error", "function\\s+\\w+").',
    ),
});

/**
 * Output schema for the framework `grep` tool and any author tool constructed
 * via {@link defineGrepTool}.
 */
export const GREP_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  matchCount: z.number().int(),
  path: z.string(),
  truncated: z.boolean(),
});

/**
 * Framework `grep` tool: searches file contents by regex pattern in the
 * agent's sandbox. Import from `eve/tools/grep` to spread, wrap, or
 * re-export it from `agent/tools/grep.ts`.
 */
export default defineTool({
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
  inputSchema: GREP_INPUT_SCHEMA,
  outputSchema: GREP_OUTPUT_SCHEMA,
  execute: async (input, ctx) => executeGrepOnSandbox(await ctx.getSandbox(), input as GrepInput),
});
