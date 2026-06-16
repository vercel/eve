import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import { type BashInput, executeBashOnSandbox } from "#execution/sandbox/bash-tool.js";
import { BASH_INPUT_SCHEMA, BASH_OUTPUT_SCHEMA } from "#runtime/framework-tools/bash.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Input shape accepted by {@link defineBashTool}.
 */
export interface DefineBashToolInput {
  /**
   * Optional model-facing description. Defaults to a generic
   * "Execute a shell command in the workspace sandbox." line.
   */
  readonly description?: string;
}

/**
 * Defines a model-visible shell-runner tool that executes commands
 * inside the agent's sandbox. Uses the same executor core as the
 * framework `bash` tool, so input schema, error messages, and result
 * shape are identical.
 *
 * The tool's runtime name comes from the authored file's slug (for
 * example `agent/tools/run_shell.ts` becomes a tool named `run_shell`).
 */
export function defineBashTool(input: DefineBashToolInput = {}): ToolDefinition {
  return {
    description: input.description ?? "Execute a shell command in the workspace sandbox.",
    async execute(args, ctx) {
      return executeBashOnSandbox(await ctx.getSandbox(), args as BashInput);
    },
    inputSchema: BASH_INPUT_SCHEMA as unknown as StandardJSONSchemaV1<unknown>,
    outputSchema: BASH_OUTPUT_SCHEMA,
  };
}
