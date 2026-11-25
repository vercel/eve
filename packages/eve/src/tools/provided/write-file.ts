import { type WriteFileInput, executeWriteFileOnSandbox } from "#execution/sandbox/write-file.js";
import { toolOutput, type ToolModelOutput } from "#tools/model-output.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

/** Input to the provided `write_file` tool: the file path and its full new content. */
export interface WriteFileToolInput {
  content: string;
  filePath: string;
}

/**
 * Result of the provided `write_file` tool: the written path and whether the file already existed.
 */
export interface WriteFileToolOutput {
  existed: boolean;
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
      description:
        "The path to the file to write: absolute, relative to the workspace root, or beginning with ~/ or $HOME/.",
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
    path: { type: "string" },
  },
  required: ["existed", "path"],
  additionalProperties: false,
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const writeFile: ToolDefinition<WriteFileToolInput, WriteFileToolOutput> = frameworkTool(
  defineTool({
    label: { start: (input) => toolLabel("Write", input.filePath) },
    description: [
      "Write a file to the local filesystem, creating missing parent directories and overwriting any existing file at the path.",
      "Prefer `edit_file` for targeted changes to existing files.",
    ].join("\n"),
    async execute(input, ctx) {
      return await executeWriteFileOnSandbox(await ctx.getSandbox(), input as WriteFileInput);
    },
    inputSchema: WRITE_FILE_INPUT_SCHEMA,
    outputSchema: WRITE_FILE_OUTPUT_SCHEMA,
    toModelOutput: writeFileModelOutput,
  }),
);

const WRITE_FILE_OUTPUT_KEYS = new Set(["existed", "path"]);

function writeFileModelOutput(output: unknown): ToolModelOutput {
  if (typeof output === "string") return toolOutput.text(output);
  if (isWriteFileResult(output)) {
    return toolOutput.text(output.existed ? `Overwrote ${output.path}.` : `Wrote ${output.path}.`);
  }
  return toolOutput.json(output);
}

function isWriteFileResult(output: unknown): output is WriteFileToolOutput {
  if (typeof output !== "object" || output === null) return false;
  const value = output as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => WRITE_FILE_OUTPUT_KEYS.has(key)) &&
    typeof value.path === "string" &&
    typeof value.existed === "boolean"
  );
}

export default writeFile;
import { frameworkTool } from "./framework-tool.js";
