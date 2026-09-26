import { executeBashOnSandbox, type BashInput } from "#execution/sandbox/bash.js";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from "#execution/sandbox/truncate-output.js";
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
  description: [
    "Execute a shell command in the shared workspace environment.",
    "",
    "Usage:",
    "- Each call starts a new shell in /workspace. `cd` and exported variables do not carry over to the next call, so chain dependent steps in one command with `&&`.",
    `- stdout and stderr each keep their last ${String(MAX_OUTPUT_LINES)} lines (${String(MAX_OUTPUT_BYTES / 1024)} KB). Cut output starts with a \`[stdout truncated: showing last N of M lines]\` marker and sets truncated to true; narrow the command with grep, head, or tail instead of rerunning it unchanged.`,
    "- A non-zero exitCode means the command failed. Read stderr before retrying.",
    "- When read_file and write_file are available, use them for file contents instead of cat, sed, or redirection: read_file returns line numbers, and write_file refuses to overwrite a file that changed since you read it.",
  ].join("\n"),
  async execute(input, ctx) {
    return await executeBashOnSandbox(await ctx.getSandbox(), input as BashInput);
  },
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
});

export default bash;
