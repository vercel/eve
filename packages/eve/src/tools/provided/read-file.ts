import { type ReadFileInput, executeReadFileOnSandbox } from "#execution/sandbox/read-file.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface ReadFileToolInput {
  filePath: string;
  limit?: number;
  offset?: number;
}

export interface ReadFileToolOutput {
  content: string;
  nextOffset?: number;
  path: string;
  totalLines: number;
  truncated: boolean;
}

/**
 * Input schema for the provided `read_file` tool.
 */
export const READ_FILE_INPUT_SCHEMA = defineJsonSchema<ReadFileToolInput>({
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description: "The absolute path to the file to read. A leading $HOME is supported.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description: "Maximum number of lines to return. Defaults to 2000.",
    },
    offset: {
      type: "integer",
      minimum: 1,
      description: "1-based line number to start from. Defaults to 1.",
    },
  },
  required: ["filePath"],
  additionalProperties: false,
});

/**
 * Output schema for the provided `read_file` tool.
 */
export const READ_FILE_OUTPUT_SCHEMA = defineJsonSchema<ReadFileToolOutput>({
  type: "object",
  properties: {
    content: { type: "string" },
    nextOffset: { type: "integer", minimum: 1 },
    path: { type: "string" },
    totalLines: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" },
  },
  required: ["content", "path", "totalLines", "truncated"],
  additionalProperties: false,
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const readFile: ToolDefinition<ReadFileToolInput, ReadFileToolOutput> = defineTool({
  label: { start: (input) => toolLabel("Read", input.filePath) },
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
