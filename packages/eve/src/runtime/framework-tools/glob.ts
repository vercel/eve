import { z } from "#compiled/zod/index.js";

/**
 * Shared input schema used by the framework `glob` tool and any author tool
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
 * Shared output schema used by the framework `glob` tool and any author tool
 * constructed via {@link defineGlobTool}.
 */
export const GLOB_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  count: z.number().int(),
  path: z.string(),
  truncated: z.boolean(),
});
