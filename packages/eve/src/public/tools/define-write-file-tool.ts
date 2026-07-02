import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import {
  executeWriteFileOnSandbox,
  type WriteFileInput,
} from "#execution/sandbox/write-file-tool.js";
import {
  WRITE_FILE_INPUT_SCHEMA,
  WRITE_FILE_OUTPUT_SCHEMA,
} from "#runtime/framework-tools/write-file.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Input shape accepted by {@link defineWriteFileTool}.
 */
export interface DefineWriteFileToolInput {
  /**
   * Optional model-facing description. Defaults to a generic
   * "Write a file to the workspace sandbox." line.
   */
  readonly description?: string;
}

/**
 * Defines a model-visible file-writer tool that writes files to the
 * agent's sandbox. Uses the same executor core as the framework
 * `write_file` tool, so input schema, error messages, and result shape
 * are identical.
 *
 * The tool's runtime name comes from the authored file's slug (for
 * example `agent/tools/write_file.ts` becomes a tool named
 * `write_file`).
 */
export function defineWriteFileTool(input: DefineWriteFileToolInput = {}): ToolDefinition {
  return {
    description: input.description ?? "Write a file to the workspace sandbox.",
    async execute(args, ctx) {
      return executeWriteFileOnSandbox(await ctx.getSandbox(), args as WriteFileInput);
    },
    inputSchema: WRITE_FILE_INPUT_SCHEMA as unknown as StandardJSONSchemaV1<unknown>,
    outputSchema: WRITE_FILE_OUTPUT_SCHEMA,
  };
}
