import { z } from "#compiled/zod/index.js";

import { type ReadFileInput, executeReadFileOnSandbox } from "#execution/sandbox/read-file-tool.js";
import { defineTool, type ToolDefinition } from "#public/definitions/tool.js";

/**
 * Input schema for the provided `read_file` tool.
 */
export const READ_FILE_INPUT_SCHEMA = z.strictObject({
  filePath: z
    .string()
    .describe("The absolute path to the file to read. A leading $HOME is supported."),
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
 * Output schema for the provided `read_file` tool.
 */
export const READ_FILE_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  nextOffset: z.number().int().min(1).optional(),
  path: z.string(),
  totalLines: z.number().int().min(0),
  truncated: z.boolean(),
});

export type ReadFileToolInput = z.infer<typeof READ_FILE_INPUT_SCHEMA>;
export type ReadFileToolOutput = z.infer<typeof READ_FILE_OUTPUT_SCHEMA>;

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const readFile: ToolDefinition<ReadFileToolInput, ReadFileToolOutput> = defineTool({
  description: [
    "Read a file from the local filesystem. If the path does not exist, an error is returned.",
    "",
    "Usage:",
    "- The filePath parameter should be an absolute path or begin with $HOME/.",
    "- By default, this tool returns up to 2000 lines from the start of the file.",
    "- The offset parameter is the line number to start from (1-indexed).",
    "- To read later sections, call this tool again with a larger offset.",
    '- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n".',
    "- Any line longer than 2000 characters is truncated.",
    "- Call this tool in parallel when you know there are multiple files you want to read.",
    "- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeReadFileOnSandbox(await ctx.getSandbox(), input as ReadFileInput);
  },
  inputSchema: READ_FILE_INPUT_SCHEMA,
  outputSchema: READ_FILE_OUTPUT_SCHEMA,
});

export default readFile;
