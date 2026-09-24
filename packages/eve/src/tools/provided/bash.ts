import { executeBashOnSandbox, type BashInput } from "#execution/sandbox/bash.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface BashToolInput {
  command: string;
}

export interface BashToolOutput {
  exitCode: number;
  stderr: string;
  stdout: string;
  truncated: boolean;
}

/**
 * Input schema for the provided `bash` tool.
 */
export const BASH_INPUT_SCHEMA = defineJsonSchema<BashToolInput>({
  type: "object",
  properties: {
    command: { type: "string", description: "The shell command to execute." },
  },
  required: ["command"],
  additionalProperties: false,
});

/**
 * Output schema for the provided `bash` tool.
 */
export const BASH_OUTPUT_SCHEMA = defineJsonSchema<BashToolOutput>({
  type: "object",
  properties: {
    exitCode: { type: "number" },
    stderr: { type: "string" },
    stdout: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["exitCode", "stderr", "stdout", "truncated"],
  additionalProperties: false,
});

/**
 * Framework-owned executors stay statically imported so hosted server bundles
 * can trace and rewrite them into deployable output chunks.
 *
 * These modules are only used by the Nitro-hosted runtime path. Their deeper
 * sandbox dependencies remain lazily loaded inside the execution layer, so the
 * top-level import here does not force those backends to initialize eagerly.
 */
export const bash: ToolDefinition<BashToolInput, BashToolOutput> = defineTool({
  label: { start: (input) => toolLabel("Run", input.command) },
  description: "Execute a shell command in the shared workspace environment.",
  async execute(input, ctx) {
    return await executeBashOnSandbox(await ctx.getSandbox(), input as BashInput);
  },
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
});

export default bash;
