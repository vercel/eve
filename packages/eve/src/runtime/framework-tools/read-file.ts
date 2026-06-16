import { executeReadFileOnSandbox, type ReadFileInput } from "#execution/sandbox/read-file-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { JsonObject } from "#shared/json.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Shared input schema used by the framework `read_file` tool and any author
 * tool constructed via {@link defineReadFileTool}.
 *
 * Exported so the public `defineReadFileTool` factory and the framework
 * `READ_FILE_TOOL_DEFINITION` use the exact same schema object — keeping
 * model input contracts in sync without duplication.
 */
export const READ_FILE_INPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    filePath: {
      description: "The absolute path to the file to read.",
      type: "string",
    },
    limit: {
      description: "Maximum number of lines to return. Defaults to 2000.",
      minimum: 1,
      type: "integer",
    },
    offset: {
      description: "1-based line number to start from. Defaults to 1.",
      minimum: 1,
      type: "integer",
    },
  },
  required: ["filePath"],
  type: "object",
};

/**
 * Shared output schema used by the framework `read_file` tool and any author
 * tool constructed via {@link defineReadFileTool}.
 */
export const READ_FILE_OUTPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    content: { type: "string" },
    nextOffset: { minimum: 1, type: "integer" },
    path: { type: "string" },
    totalLines: { minimum: 0, type: "integer" },
    truncated: { type: "boolean" },
  },
  required: ["content", "path", "totalLines", "truncated"],
  type: "object",
};

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
async function executeReadFile(input: unknown): Promise<unknown> {
  return executeReadFileOnSandbox(await requireSandboxSession(), input as ReadFileInput);
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
