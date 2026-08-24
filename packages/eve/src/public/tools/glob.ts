import { z } from "#compiled/zod/index.js";

import { executeGlobOnSandbox, type GlobInput } from "#execution/sandbox/glob-tool.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Shared input schema used by eve's `glob` primitive and any author tool
 * constructed via {@link defineGlobTool}.
 *
 * Exported so the public `defineGlobTool` factory and defaults share one model
 * input contract.
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
 * Shared output schema used by eve's `glob` primitive and any author tool
 * constructed via {@link defineGlobTool}.
 */
export const GLOB_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  count: z.number().int(),
  path: z.string(),
  truncated: z.boolean(),
});

/** Input accepted by {@link defineGlobTool}. */
export interface DefineGlobToolInput {
  /** Optional model-facing description. */
  readonly description?: string;
}

/** Defines a file-search tool that executes in the agent sandbox. */
export function defineGlobTool(input: DefineGlobToolInput = {}): ToolDefinition {
  return {
    description: input.description ?? "Search for files by glob pattern in the workspace sandbox.",
    async execute(args, ctx) {
      return executeGlobOnSandbox(await ctx.getSandbox(), args as GlobInput);
    },
    inputSchema: GLOB_INPUT_SCHEMA,
    outputSchema: GLOB_OUTPUT_SCHEMA,
  };
}

/** eve's canonical opt-in file search definition. */
export const glob: ToolDefinition = defineGlobTool();
