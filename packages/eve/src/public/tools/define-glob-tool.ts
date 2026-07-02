import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import { executeGlobOnSandbox, type GlobInput } from "#execution/sandbox/glob-tool.js";
import { GLOB_INPUT_SCHEMA, GLOB_OUTPUT_SCHEMA } from "#runtime/framework-tools/glob.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Input shape accepted by {@link defineGlobTool}.
 */
export interface DefineGlobToolInput {
  /**
   * Optional model-facing description. Defaults to a generic
   * "Search for files by glob pattern in the workspace sandbox." line.
   */
  readonly description?: string;
}

/**
 * Defines a model-visible file-search tool that discovers files by
 * glob pattern inside the agent's sandbox. Uses the same executor core
 * as the framework `glob` tool, so input schema, error messages, and
 * result shape are identical.
 *
 * The tool's runtime name comes from the authored file's slug (for
 * example `agent/tools/find_files.ts` becomes a tool named
 * `find_files`).
 */
export function defineGlobTool(input: DefineGlobToolInput = {}): ToolDefinition {
  return {
    description: input.description ?? "Search for files by glob pattern in the workspace sandbox.",
    async execute(args, ctx) {
      return executeGlobOnSandbox(await ctx.getSandbox(), args as GlobInput);
    },
    inputSchema: GLOB_INPUT_SCHEMA as unknown as StandardJSONSchemaV1<unknown>,
    outputSchema: GLOB_OUTPUT_SCHEMA,
  };
}
