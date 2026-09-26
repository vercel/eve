import { type WriteFileInput, executeWriteFileOnSandbox } from "#execution/sandbox/write-file.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface WriteFileToolInput {
  content: string;
  filePath: string;
}

export interface WriteFileToolOutput {
  existed: boolean;
  lineCount: number;
  path: string;
}

/**
 * Input schema for the provided `write_file` tool.
 */
export const WRITE_FILE_INPUT_SCHEMA = defineJsonSchema<WriteFileToolInput>({
  type: "object",
  properties: {
    content: { type: "string", description: "Complete replacement file contents." },
    filePath: {
      type: "string",
      description: "The absolute path to the file to write. A leading $HOME is supported.",
    },
  },
  required: ["content", "filePath"],
  additionalProperties: false,
});

/**
 * Output schema for the provided `write_file` tool.
 */
export const WRITE_FILE_OUTPUT_SCHEMA = defineJsonSchema<WriteFileToolOutput>({
  type: "object",
  properties: {
    existed: { type: "boolean" },
    lineCount: { type: "integer", minimum: 0 },
    path: { type: "string" },
  },
  required: ["existed", "lineCount", "path"],
  additionalProperties: false,
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const writeFile: ToolDefinition<WriteFileToolInput, WriteFileToolOutput> = defineTool({
  label: { start: (input) => toolLabel("Write", input.filePath) },
  description: [
    "Write complete contents to a text file, creating it or replacing an existing file.",
    "",
    "Usage:",
    "- The filePath parameter should be an absolute path or begin with $HOME/.",
    "- content replaces the whole file, so include every line you want to keep.",
    "- New files need no prior read.",
    "- Before overwriting an existing file, read it with the read_file tool. The write fails if you have not read the file or if it changed since your last read; read it again, then retry.",
    "- Returns the written path, whether the file already existed, and its line count.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeWriteFileOnSandbox(await ctx.getSandbox(), input as WriteFileInput);
  },
  inputSchema: WRITE_FILE_INPUT_SCHEMA,
  outputSchema: WRITE_FILE_OUTPUT_SCHEMA,
});

export default writeFile;
