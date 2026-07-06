import { executeGlobOnSandbox, type GlobInput } from "#execution/sandbox/glob-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import type { JsonObject } from "#shared/json.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Shared input schema used by the framework `glob` tool and any author tool
 * constructed via {@link defineGlobTool}.
 *
 * Exported so the public `defineGlobTool` factory and the framework
 * `GLOB_TOOL_DEFINITION` use the exact same schema object — keeping model
 * input contracts in sync without duplication.
 */
export const GLOB_INPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    limit: {
      description: "Maximum number of results to return. Defaults to 100.",
      maximum: 1000,
      minimum: 1,
      type: "integer",
    },
    path: {
      description:
        "The directory to search in. Defaults to /workspace. " +
        "Must be an absolute path. Omit to use the default.",
      type: "string",
    },
    pattern: {
      description: 'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.js").',
      type: "string",
    },
  },
  required: ["pattern"],
  type: "object",
};

/**
 * Shared output schema used by the framework `glob` tool and any author tool
 * constructed via {@link defineGlobTool}.
 */
export const GLOB_OUTPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    content: { type: "string" },
    count: { type: "integer" },
    path: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["content", "count", "path", "truncated"],
  type: "object",
};

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
async function executeGlob(input: unknown, options?: ToolExecuteOptions): Promise<unknown> {
  return executeGlobOnSandbox(
    await requireSandboxSession(options?.abortSignal),
    input as GlobInput,
  );
}

export const GLOB_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Fast file pattern matching tool that works with any codebase size.",
    "",
    "Usage:",
    '- Supports glob patterns like "**/*.js" or "src/**/*.ts".',
    "- Returns matching file paths.",
    "- Use this tool when you need to find files by name patterns.",
    "- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.",
    "- Use the grep tool instead if you need to search file contents.",
    "- Call this tool in parallel when you know there are multiple patterns to search for.",
  ].join("\n"),
  execute: executeGlob,
  inputSchema: GLOB_INPUT_SCHEMA,
  logicalPath: "eve:framework/glob",
  name: "glob",
  outputSchema: GLOB_OUTPUT_SCHEMA,
  sourceId: "eve:glob-tool",
  sourceKind: "module",
};
