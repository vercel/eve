import { z } from "#compiled/zod/index.js";

import { type BashInput, executeBashOnSandbox } from "#execution/sandbox/bash-tool.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Shared input schema used by eve's default `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 *
 * Exported so the public `defineBashTool` factory and defaults share one
 * model input contract.
 */
export const BASH_INPUT_SCHEMA = z.strictObject({
  command: z.string().describe("The shell command to execute."),
});

/**
 * Shared output schema used by eve's default `bash` tool and any author tool
 * constructed via {@link defineBashTool}.
 */
export const BASH_OUTPUT_SCHEMA = z.strictObject({
  exitCode: z.number(),
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
});

/** Input accepted by {@link defineBashTool}. */
export interface DefineBashToolInput {
  /** Optional model-facing description. */
  readonly description?: string;
}

/** Defines a shell tool that executes commands in the agent sandbox. */
export function defineBashTool(input: DefineBashToolInput = {}): ToolDefinition {
  return {
    description: input.description ?? "Execute a shell command in the workspace sandbox.",
    async execute(args, ctx) {
      return executeBashOnSandbox(await ctx.getSandbox(), args as BashInput);
    },
    inputSchema: BASH_INPUT_SCHEMA,
    outputSchema: BASH_OUTPUT_SCHEMA,
  };
}

/** eve's canonical default shell execution definition. */
export const bash: ToolDefinition = defineBashTool({
  description: "Execute a shell command in the shared workspace environment.",
});
