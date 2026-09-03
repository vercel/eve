import { z } from "#compiled/zod/index.js";

import { type GlobInput, executeGlobOnSandbox } from "#execution/sandbox/glob-tool.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";

/**
 * Input schema for the provided `glob` tool.
 */
export const GLOB_INPUT_SCHEMA = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .describe("Maximum number of results to return. Defaults to 100.")
    .optional(),
  path: z
    .string()
    .describe(
      "The directory to search in. Defaults to /workspace. " +
        "Must be an absolute path or begin with $HOME/. Omit to use the default.",
    )
    .optional(),
  pattern: z
    .string()
    .describe('The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.js").'),
});

/**
 * Output schema for the provided `glob` tool.
 */
export const GLOB_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  count: z.number().int(),
  path: z.string(),
  truncated: z.boolean(),
});

export type GlobToolInput = z.infer<typeof GLOB_INPUT_SCHEMA>;
export type GlobToolOutput = z.infer<typeof GLOB_OUTPUT_SCHEMA>;

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const glob: ToolDefinition<GlobToolInput, GlobToolOutput> = defineTool({
  label: { start: (input) => toolLabel("Find", input.pattern) },
  description: [
    "Fast file pattern matching tool that works with any codebase size.",
    "",
    "Usage:",
    '- Supports glob patterns like "**/*.js" or "src/**/*.ts".',
    "- Returns matching file paths.",
    "- Call this tool in parallel when you know there are multiple patterns to search for.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeGlobOnSandbox(await ctx.getSandbox(), input as GlobInput);
  },
  inputSchema: GLOB_INPUT_SCHEMA,
  outputSchema: GLOB_OUTPUT_SCHEMA,
});

export default glob;
