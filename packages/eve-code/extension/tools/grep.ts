import { defineTool } from "eve/tools";
import { z } from "zod";

import { GREP_OUTPUT_MODES, MAX_GREP_LIMIT, executeGrepSearch } from "../lib/grep-search.ts";

const InputSchema = z.object({
  context: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Context lines around each content match. Ignored unless outputMode is content."),
  glob: z.string().optional().describe('Limit files, for example "*.ts" or "*.{ts,tsx}".'),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search. Defaults to false."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_GREP_LIMIT)
    .optional()
    .describe("Maximum rows to return. Defaults to 50."),
  literal: z
    .boolean()
    .optional()
    .describe(
      "Force a literal match. Defaults to true for identifier-like patterns, false when the pattern uses regex syntax.",
    ),
  outputMode: z
    .enum(GREP_OUTPUT_MODES)
    .optional()
    .describe(
      "files_with_matches lists files and stops at the first hit in each (default). content returns matching lines. count returns per-file totals.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Directory or file inside the workspace. Defaults to the workspace root. Narrow this first.",
    ),
  pattern: z.string().min(1).describe("Regex or literal to search for."),
});

export default defineTool({
  description: [
    "Search file contents in the sandbox with ripgrep.",
    "Start with files_with_matches and a narrow path or glob, then read matching lines with content or size a pattern with count.",
    "Patterns without regex syntax match literally unless literal is false.",
    "Hidden files are included and .git is excluded. Ripgrep respects .gitignore; the POSIX fallback does not read .gitignore.",
  ].join(" "),
  inputSchema: InputSchema,
  outputSchema: z.object({
    content: z.string(),
    matchCount: z.number().int(),
    outputMode: z.enum(GREP_OUTPUT_MODES),
    path: z.string(),
    truncated: z.boolean(),
  }),
  async execute(input, ctx) {
    return executeGrepSearch(input, await ctx.getSandbox(), ctx.abortSignal);
  },
});
