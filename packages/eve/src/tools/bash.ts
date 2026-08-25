import { z } from "#compiled/zod/index.js";

import { executeBashOnSandbox, type BashInput } from "#execution/sandbox/bash-tool.js";
import { defineTool } from "#public/definitions/tool.js";

/**
 * Shared input schema used by the framework `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 *
 * Exported so the public `defineBashTool` factory and the framework
 * `BASH_TOOL_DEFINITION` use the exact same schema object — keeping model
 * input contracts in sync without duplication.
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

/**
 * Framework-owned executors stay statically imported so hosted server bundles
 * can trace and rewrite them into deployable output chunks.
 *
 * These modules are only used by the Nitro-hosted runtime path. Their deeper
 * sandbox dependencies remain lazily loaded inside the execution layer, so the
 * top-level import here does not force those backends to initialize eagerly.
 */
export const bash = defineTool({
  description: "Execute a shell command in the shared workspace environment.",
  async execute(input, ctx) {
    return await executeBashOnSandbox(await ctx.getSandbox(), input as BashInput);
  },
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
});

export default bash;
