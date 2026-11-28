import { type ReadFileInput, executeReadFileOnSandbox } from "#execution/sandbox/read-file.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { basename } from "node:path";

import { contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { resolveAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import { toolOutput, toolOutputPart } from "#tools/model-output.js";
import { defineJsonSchema, prepareJsonSchema } from "#tools/schema.js";

import { prepareFilePathAlias } from "./file-path-alias.js";

/** Input to the provided `read_file` tool: the file to read and an optional line range. */
export interface ReadFileToolInput {
  filePath: string;
  limit?: number;
  offset?: number;
}

/**
 * Result of the provided `read_file` tool: the file's content with paging details, or file
 * metadata for an image or PDF the model reads natively.
 */
export interface ReadFileToolOutput {
  content: string;
  /** Set when the file is a PNG, JPEG, GIF, or WebP image or a PDF that the model reads natively. */
  file?: {
    height?: number;
    mediaType: string;
    pages?: number;
    size: number;
    width?: number;
  };
  nextOffset?: number;
  path: string;
  totalLines: number;
  truncated: boolean;
}

/**
 * Input schema for the provided `read_file` tool.
 */
export const READ_FILE_INPUT_SCHEMA = prepareJsonSchema<ReadFileToolInput>(
  {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description:
          "The path to the file to read: absolute, relative to the workspace root, or beginning with ~/ or $HOME/.",
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
  },
  prepareFilePathAlias,
);

/**
 * Output schema for the provided `read_file` tool.
 */
export const READ_FILE_OUTPUT_SCHEMA = defineJsonSchema<ReadFileToolOutput>({
  type: "object",
  properties: {
    content: { type: "string" },
    file: {
      type: "object",
      properties: {
        height: { type: "integer", minimum: 1 },
        mediaType: { type: "string" },
        pages: { type: "integer", minimum: 1 },
        size: { type: "integer", minimum: 0 },
        width: { type: "integer", minimum: 1 },
      },
      required: ["mediaType", "size"],
      additionalProperties: false,
    },
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
export const readFile: ToolDefinition<ReadFileToolInput, ReadFileToolOutput> = frameworkTool(
  defineTool({
    label: { start: (input) => toolLabel("Read", input.filePath) },
    description: [
      "Read the contents of a file. Supports text files, images (PNG, JPEG, GIF, WebP), and PDFs, including `Attached file <path>` references. Images and PDFs are sent as attachments.",
      "Text is returned with a `<line>: ` prefix on each line; the prefix is not part of the file. Output stops at `limit` lines or 50 KB, whichever is hit first. Use `offset` and `limit` for large files, in large windows rather than tiny slices. When you need the full file, continue with `offset` until complete.",
    ].join("\n"),
    async execute(input, ctx) {
      return await executeReadFileOnSandbox(await ctx.getSandbox(), input as ReadFileInput);
    },
    inputSchema: READ_FILE_INPUT_SCHEMA,
    outputSchema: READ_FILE_OUTPUT_SCHEMA,
    async toModelOutput(output) {
      if (!isReadFileResult(output)) {
        return typeof output === "string" ? toolOutput.text(output) : toolOutput.json(output);
      }
      if (output.file === undefined) return toolOutput.text(formatReadFileModelOutput(output));
      const sandbox = await contextStorage.getStore()?.get(SandboxKey)?.get();
      const bytes =
        sandbox === undefined || sandbox === null
          ? null
          : await sandbox.readBinaryFile({
              path: await resolveAbsoluteFilePath(sandbox, output.path),
            });
      if (bytes === null) return toolOutput.text(`${output.content} The file could not be loaded.`);
      if (bytes.byteLength !== output.file.size) {
        return toolOutput.text(
          `${output.content} The file changed after it was read; read it again.`,
        );
      }
      return toolOutput.content([
        toolOutputPart.text(output.content),
        toolOutputPart.file(Buffer.from(bytes).toString("base64"), {
          filename: basename(output.path),
          mediaType: output.file.mediaType,
        }),
      ]);
    },
  }),
);

const READ_FILE_OUTPUT_KEYS = new Set([
  "content",
  "file",
  "nextOffset",
  "path",
  "totalLines",
  "truncated",
]);

function isReadFileResult(output: unknown): output is ReadFileToolOutput {
  if (typeof output !== "object" || output === null) return false;
  const value = output as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => READ_FILE_OUTPUT_KEYS.has(key)) &&
    typeof value.content === "string" &&
    typeof value.path === "string" &&
    typeof value.totalLines === "number" &&
    typeof value.truncated === "boolean"
  );
}

function formatReadFileModelOutput(output: ReadFileToolOutput): string {
  if (output.totalLines === 0) return `[${output.path}: empty file]`;
  if (!output.truncated) return output.content;
  const shownEnd = output.nextOffset !== undefined ? output.nextOffset - 1 : output.totalLines;
  const continuation =
    output.nextOffset !== undefined ? ` Use offset=${output.nextOffset} to read more.` : "";
  return `${output.content}\n[Truncated: showing through line ${shownEnd} of ${output.totalLines}.${continuation}]`;
}

export default readFile;
import { frameworkTool } from "./framework-tool.js";
