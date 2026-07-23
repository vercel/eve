import { z } from "#compiled/zod/index.js";

import {
  executeWriteFileOnSandbox,
  type WriteFileInput,
} from "#execution/sandbox/write-file-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Shared input schema used by the framework `write_file` tool and any author
 * tool constructed via {@link defineWriteFileTool}.
 *
 * Exported so the public `defineWriteFileTool` factory and the framework
 * `WRITE_FILE_TOOL_DEFINITION` use the exact same schema object — keeping
 * model input contracts in sync without duplication.
 */
export const WRITE_FILE_INPUT_SCHEMA = z.strictObject({
  content: z.string().describe("Complete replacement file contents."),
  filePath: z
    .string()
    .describe("The absolute path to the file to write (must be absolute, not relative)."),
});

/**
 * Shared output schema used by the framework `write_file` tool and any author
 * tool constructed via {@link defineWriteFileTool}.
 */
export const WRITE_FILE_OUTPUT_SCHEMA = z.strictObject({
  existed: z.boolean(),
  path: z.string(),
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
async function executeWriteFile(input: unknown, options?: ToolExecuteOptions): Promise<unknown> {
  return executeWriteFileOnSandbox(
    await requireSandboxSession(options?.abortSignal),
    input as WriteFileInput,
  );
}

export const WRITE_FILE_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Writes a file to the local filesystem.",
    "",
    "Usage:",
    "- This tool will overwrite the existing file if there is one at the provided path.",
    "- If this is an existing file, you MUST use the read_file tool first to read the file's contents. This tool will fail if you did not read the file first.",
    "- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.",
    "- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.",
    "- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
  ].join("\n"),
  execute: executeWriteFile,
  inputSchema: WRITE_FILE_INPUT_SCHEMA,
  logicalPath: "eve:framework/write-file",
  name: "write_file",
  outputSchema: WRITE_FILE_OUTPUT_SCHEMA,
  sourceId: "eve:write-file-tool",
  sourceKind: "module",
};
