import { z } from "#compiled/zod/index.js";

import { executeReadFileOnSandbox, type ReadFileInput } from "#execution/sandbox/read-file-tool.js";
import { defineTool } from "#public/definitions/tool.js";

/**
 * Input schema for the framework `read_file` tool and any author tool
 * constructed via {@link defineReadFileTool}. Single source of truth so
 * model input contracts stay in sync without duplication.
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
 * Output schema for the framework `read_file` tool and any author tool
 * constructed via {@link defineReadFileTool}.
 */
export const READ_FILE_OUTPUT_SCHEMA = z.strictObject({
  content: z.string(),
  nextOffset: z.number().int().min(1).optional(),
  path: z.string(),
  totalLines: z.number().int().min(0),
  truncated: z.boolean(),
});

/**
 * Framework `read_file` tool: reads a file from the agent's sandbox and
 * records the read-before-write stamp used by `write_file`. Import from
 * `eve/tools/read_file` to spread, wrap, or re-export it from
 * `agent/tools/read_file.ts`.
 */
export default defineTool({
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
  inputSchema: READ_FILE_INPUT_SCHEMA,
  outputSchema: READ_FILE_OUTPUT_SCHEMA,
  execute: async (input, ctx) =>
    executeReadFileOnSandbox(await ctx.getSandbox(), input as ReadFileInput),
});
