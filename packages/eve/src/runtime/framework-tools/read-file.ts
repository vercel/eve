import { z } from "#compiled/zod/index.js";

import { executeReadFileOnSandbox, type ReadFileInput } from "#execution/sandbox/read-file-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Shared input schema used by the framework `read_file` tool and any author
 * tool constructed via {@link defineReadFileTool}.
 *
 * Exported so the public `defineReadFileTool` factory and the framework
 * `READ_FILE_TOOL_DEFINITION` use the exact same schema object — keeping
 * model input contracts in sync without duplication.
 */
export const READ_FILE_INPUT_SCHEMA = z.strictObject({
  filePath: z.string().describe("The absolute path to the file to read."),
  limit: z
    .number()
    .int()
    .min(1)
    .describe("Maximum number of lines to return. Defaults to 2000.")
    .optional(),
  offset: z
    .number()
    .int()
    .min(1)
    .describe("1-based line number to start from. Defaults to 1.")
    .optional(),
});

/**
 * Shared output schema used by the framework `read_file` tool and any author
 * tool constructed via {@link defineReadFileTool}.
 */
export const READ_FILE_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  nextOffset: z.number().int().min(1).optional(),
  path: z.string(),
  totalLines: z.number().int().min(0),
  truncated: z.boolean(),
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
async function executeReadFile(input: unknown, options?: ToolExecuteOptions): Promise<unknown> {
  return executeReadFileOnSandbox(
    await requireSandboxSession(options?.abortSignal),
    input as ReadFileInput,
  );
}

export const READ_FILE_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Read a file from the local filesystem. If the path does not exist, an error is returned.",
    "",
    "Usage:",
    "- The filePath parameter should be an absolute path.",
    "- By default, this tool returns up to 2000 lines from the start of the file.",
    "- The offset parameter is the line number to start from (1-indexed).",
    "- To read later sections, call this tool again with a larger offset.",
    "- Use the grep tool to find specific content in large files or files with long lines.",
    "- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.",
    '- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n".',
    "- Any line longer than 2000 characters is truncated.",
    "- Call this tool in parallel when you know there are multiple files you want to read.",
    "- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.",
  ].join("\n"),
  execute: executeReadFile,
  inputSchema: READ_FILE_INPUT_SCHEMA,
  logicalPath: "eve:framework/read-file",
  name: "read_file",
  outputSchema: READ_FILE_OUTPUT_SCHEMA,
  sourceId: "eve:read-file-tool",
  sourceKind: "module",
};
