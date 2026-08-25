import { z } from "#compiled/zod/index.js";

import { type BashInput, executeBashOnSandbox } from "#execution/sandbox/bash-tool.js";
import { defineTool } from "#public/definitions/tool.js";

/**
 * Input schema for the framework `bash` tool and any author tool constructed
 * via {@link defineBashTool}. Single source of truth so model input contracts
 * stay in sync without duplication.
 */
export const BASH_INPUT_SCHEMA = z.strictObject({
  command: z.string().describe("The shell command to execute."),
});

/**
 * Output schema for the framework `bash` tool and any author tool constructed
 * via {@link defineBashTool}.
 */
export const BASH_OUTPUT_SCHEMA = z.strictObject({
  exitCode: z.number(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

/**
 * Framework `bash` tool: executes a shell command in the agent's sandbox.
 * Import from `eve/tools/bash` to spread, wrap, or re-export it from
 * `agent/tools/bash.ts`.
 */
export default defineTool({
  description: "Execute a shell command in the shared workspace environment.",
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
  execute: async (input, ctx) => executeBashOnSandbox(await ctx.getSandbox(), input as BashInput),
});
