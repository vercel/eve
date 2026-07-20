import { z } from "#compiled/zod/index.js";

import { executeGlobOnSandbox, type GlobInput } from "#execution/sandbox/glob-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Shared input schema used by the framework `glob` tool and any author tool
 * constructed via {@link defineGlobTool}.
 *
 * Exported so the public `defineGlobTool` factory and the framework
 * `GLOB_TOOL_DEFINITION` use the exact same schema object — keeping model
 * input contracts in sync without duplication.
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
        "Must be an absolute path. Omit to use the default.",
    )
    .optional(),
  pattern: z
    .string()
    .describe('The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.js").'),
});

/**
 * Shared output schema used by the framework `glob` tool and any author tool
 * constructed via {@link defineGlobTool}.
 */
export const GLOB_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  count: z.number().int(),
  path: z.string(),
  truncated: z.boolean(),
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
async function executeGlob(input: unknown, options?: ToolExecuteOptions): Promise<unknown> {
  return executeGlobOnSandbox(
    await requireSandboxSession(options?.abortSignal),
    input as GlobInput,
  );
}

export const GLOB_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Fast file pattern matching tool that works with any codebase size.",
    "",
    "Usage:",
    '- Supports glob patterns like "**/*.js" or "src/**/*.ts".',
    "- Returns matching file paths.",
    "- Use this tool when you need to find files by name patterns.",
    "- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.",
    "- Use the grep tool instead if you need to search file contents.",
    "- Call this tool in parallel when you know there are multiple patterns to search for.",
  ].join("\n"),
  execute: executeGlob,
  inputSchema: GLOB_INPUT_SCHEMA,
  logicalPath: "eve:framework/glob",
  name: "glob",
  outputSchema: GLOB_OUTPUT_SCHEMA,
  sourceId: "eve:glob-tool",
  sourceKind: "module",
};
