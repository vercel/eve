import { z } from "#compiled/zod/index.js";

import { executeGrepOnSandbox, type GrepInput } from "#execution/sandbox/grep-tool.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Shared input schema used by eve's `grep` primitive and any author tool
 * constructed via {@link defineGrepTool}.
 *
 * Exported so the public `defineGrepTool` factory and defaults share one model
 * input contract.
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
 * Shared output schema used by eve's `grep` primitive and any author tool
 * constructed via {@link defineGrepTool}.
 */
export const GREP_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  matchCount: z.number().int(),
  path: z.string(),
  truncated: z.boolean(),
});

/** Input accepted by {@link defineGrepTool}. */
export interface DefineGrepToolInput {
  /** Optional model-facing description. */
  readonly description?: string;
}

/** Defines a content-search tool that executes in the agent sandbox. */
export function defineGrepTool(input: DefineGrepToolInput = {}): ToolDefinition {
  return {
    description: input.description ?? "Search file contents by pattern in the workspace sandbox.",
    async execute(args, ctx) {
      return executeGrepOnSandbox(await ctx.getSandbox(), args as GrepInput);
    },
    inputSchema: GREP_INPUT_SCHEMA,
    outputSchema: GREP_OUTPUT_SCHEMA,
  };
}

/** eve's canonical opt-in content search definition. */
export const grep: ToolDefinition = defineGrepTool();
