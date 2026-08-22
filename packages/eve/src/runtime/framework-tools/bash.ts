import { z } from "#compiled/zod/index.js";

/**
 * Shared input schema used by the framework `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 *
 * Exported so the public `defineBashTool` factory and defaults share one
 * model input contract.
 */
export const BASH_INPUT_SCHEMA = z.strictObject({
  command: z.string().describe("The shell command to execute."),
});

/**
 * Shared output schema used by the framework `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 */
export const BASH_OUTPUT_SCHEMA = z.strictObject({
  exitCode: z.number(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});
