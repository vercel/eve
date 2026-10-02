import { type GlobInput, executeGlobOnSandbox } from "#execution/sandbox/glob-tool.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface GlobToolInput {
  limit?: number;
  path?: string;
  pattern: string;
}

export interface GlobToolOutput {
  content: string;
  count: number;
  path: string;
  truncated: boolean;
}

/**
 * Input schema for the provided `glob` tool.
 */
export const GLOB_INPUT_SCHEMA = defineJsonSchema<GlobToolInput>({
  type: "object",
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description: "Maximum number of results to return. Defaults to 100.",
    },
    path: {
      type: "string",
      description:
        "The directory to search in. Defaults to /workspace. " +
        "Must be an absolute path or begin with $HOME/. Omit to use the default.",
    },
    pattern: {
      type: "string",
      description: 'The glob pattern to match files against (e.g. "**/*.ts", "src/**/*.js").',
    },
  },
  required: ["pattern"],
  additionalProperties: false,
});

/**
 * Output schema for the provided `glob` tool.
 */
export const GLOB_OUTPUT_SCHEMA = defineJsonSchema<GlobToolOutput>({
  type: "object",
  properties: {
    content: { type: "string" },
    count: { type: "integer" },
    path: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["content", "count", "path", "truncated"],
  additionalProperties: false,
});

/**
 * Framework-owned executor that delegates to the default sandbox.
 */
export const glob: ToolDefinition<GlobToolInput, GlobToolOutput> = defineTool({
  label: { start: (input) => toolLabel("Find", input.pattern) },
  description: [
    "Fast file pattern matching tool that works with any codebase size.",
    "",
    "Usage:",
    '- Supports glob patterns like "**/*.js" or "src/**/*.ts".',
    "- Returns matching file paths.",
    "- Call this tool in parallel when you know there are multiple patterns to search for.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeGlobOnSandbox(await ctx.getSandbox(), input as GlobInput);
  },
  inputSchema: GLOB_INPUT_SCHEMA,
  outputSchema: GLOB_OUTPUT_SCHEMA,
});

export default glob;
