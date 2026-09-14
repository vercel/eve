import { z } from "#compiled/zod/index.js";

import { type WriteFileInput, executeWriteFileOnSandbox } from "#execution/sandbox/write-file.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";

/**
 * Input schema for the provided `write_file` tool.
 */
export const WRITE_FILE_INPUT_SCHEMA = z.strictObject({
  content: z.string().describe("Complete replacement file contents."),
  filePath: z
    .string()
    .describe("The absolute path to the file to write. A leading $HOME is supported."),
});

/**
 * Output schema for the provided `write_file` tool.
 */
export const WRITE_FILE_OUTPUT_SCHEMA = z.strictObject({
  existed: z.boolean(),
  path: z.string(),
});

export type WriteFileToolInput = z.infer<typeof WRITE_FILE_INPUT_SCHEMA>;
export type WriteFileToolOutput = z.infer<typeof WRITE_FILE_OUTPUT_SCHEMA>;

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const writeFile: ToolDefinition<WriteFileToolInput, WriteFileToolOutput> = defineTool({
  label: { start: (input) => toolLabel("Write", input.filePath) },
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
  async execute(input, ctx) {
    return await executeWriteFileOnSandbox(await ctx.getSandbox(), input as WriteFileInput);
  },
  inputSchema: WRITE_FILE_INPUT_SCHEMA,
  outputSchema: WRITE_FILE_OUTPUT_SCHEMA,
});

export default writeFile;
