import { type GlobInput, executeGlobOnSandbox } from "#execution/sandbox/glob-tool.js";
import { toolOutput, type ToolModelOutput } from "#tools/model-output.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

/** Input to the provided `glob` tool: the pattern to match, where to search, and a result limit. */
export interface GlobToolInput {
  limit?: number;
  path?: string;
  pattern: string;
}

/**
 * Result of the provided `glob` tool: the matching paths, their count, the path searched, and
 * whether the list was truncated.
 */
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
        "The directory to search in: absolute, relative to the workspace root, or beginning with ~/ or $HOME/. " +
        "Omit to search the workspace root.",
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
export const glob: ToolDefinition<GlobToolInput, GlobToolOutput> = frameworkTool(
  defineTool({
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
    toModelOutput: globModelOutput,
  }),
);

const GLOB_OUTPUT_KEYS = new Set(["content", "count", "path", "truncated"]);

function globModelOutput(output: unknown): ToolModelOutput {
  if (typeof output === "string") return toolOutput.text(output);
  if (isGlobResult(output)) {
    return toolOutput.text(output.content.length === 0 ? "No files found" : output.content);
  }
  return toolOutput.json(output);
}

function isGlobResult(output: unknown): output is GlobToolOutput {
  if (typeof output !== "object" || output === null) return false;
  const value = output as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => GLOB_OUTPUT_KEYS.has(key)) &&
    typeof value.content === "string" &&
    typeof value.count === "number" &&
    typeof value.path === "string" &&
    typeof value.truncated === "boolean"
  );
}

export default glob;
import { frameworkTool } from "./framework-tool.js";
