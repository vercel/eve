import { executeReadFileOnSandbox, type ReadFileInput } from "#execution/sandbox/read-file-tool.js";
import {
  READ_FILE_INPUT_SCHEMA,
  READ_FILE_OUTPUT_SCHEMA,
} from "#runtime/framework-tools/read-file.js";
import type { ToolDefinition } from "#public/definitions/tool.js";

/**
 * Input shape accepted by {@link defineReadFileTool}.
 */
export interface DefineReadFileToolInput {
  /**
   * Optional model-facing description. Defaults to a generic
   * "Read a file from the workspace sandbox." line.
   */
  readonly description?: string;
}

/**
 * Defines a model-visible file-reader tool that reads files from the
 * agent's sandbox. Uses the same executor core as the framework
 * `read_file` tool, so input schema, error messages, and result shape
 * are identical.
 *
 * The tool's runtime name comes from the authored file's slug (for
 * example `agent/tools/read_file.ts` becomes a tool named `read_file`).
 */
export function defineReadFileTool(input: DefineReadFileToolInput = {}): ToolDefinition {
  return {
    description: input.description ?? "Read a file from the workspace sandbox.",
    async execute(args, ctx) {
      return executeReadFileOnSandbox(await ctx.getSandbox(), args as ReadFileInput);
    },
    inputSchema: READ_FILE_INPUT_SCHEMA,
    outputSchema: READ_FILE_OUTPUT_SCHEMA,
  };
}
