import {
  BASH_YIELD_SECONDS,
  executeBashOnSandbox,
  type BashInput,
} from "#execution/sandbox/bash.js";
import { frameworkTool } from "./framework-tool.js";
import { toolOutput, type ToolModelOutput } from "#tools/model-output.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface BashToolInput {
  command: string;
}

/**
 * Output of the provided `bash` tool. A command that finishes within 30
 * seconds is `completed`. A longer command keeps running in the sandbox as
 * process group `pid` and returns `running` with its output so far; it keeps
 * writing `stdout`, `stderr`, and finally `exit` files in `outputDirectory`.
 */
export type BashToolOutput =
  | {
      status: "completed";
      exitCode: number;
      stderr: string;
      stdout: string;
      truncated: boolean;
    }
  | {
      status: "running";
      pid: number;
      outputDirectory: string;
      message: string;
      stderr: string;
      stdout: string;
      truncated: boolean;
    };

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
  oneOf: [
    {
      type: "object",
      properties: {
        status: { const: "completed" },
        exitCode: { type: "number" },
        stderr: { type: "string" },
        stdout: { type: "string" },
        truncated: { type: "boolean" },
      },
      required: ["status", "exitCode", "stderr", "stdout", "truncated"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: { const: "running" },
        pid: { type: "number" },
        outputDirectory: { type: "string" },
        message: { type: "string" },
        stderr: { type: "string" },
        stdout: { type: "string" },
        truncated: { type: "boolean" },
      },
      required: ["status", "pid", "outputDirectory", "message", "stderr", "stdout", "truncated"],
      additionalProperties: false,
    },
  ],
});

/**
 * Framework-owned executors stay statically imported so hosted server bundles
 * can trace and rewrite them into deployable output chunks.
 *
 * These modules are only used by the Nitro-hosted runtime path. Their deeper
 * sandbox dependencies remain lazily loaded inside the execution layer, so the
 * top-level import here does not force those backends to initialize eagerly.
 */
export const bash: ToolDefinition<BashToolInput, BashToolOutput> = frameworkTool(
  defineTool({
    label: { start: (input) => toolLabel("Run", input.command) },
    description: `Execute a shell command in the shared workspace environment. The result is the command's stdout, then any stderr after a \`[stderr]\` line. The final line is always \`[exit code: N]\` or a note that the command is still running, and only that final line reports how the command ended. A command still running after ${BASH_YIELD_SECONDS} seconds keeps running in the background, and the note says how to check on or stop it.`,
    async execute(input, ctx) {
      return await executeBashOnSandbox(await ctx.getSandbox(), input as BashInput, {
        abortSignal: ctx.abortSignal,
      });
    },
    inputSchema: BASH_INPUT_SCHEMA,
    outputSchema: BASH_OUTPUT_SCHEMA,
    toModelOutput: bashModelOutput,
  }),
);

/** Every key a `bash` result can have, across both statuses. */
const BASH_OUTPUT_KEYS = new Set([
  "exitCode",
  "message",
  "outputDirectory",
  "pid",
  "status",
  "stderr",
  "stdout",
  "truncated",
]);

/**
 * Shows the model plain text, so source, diffs, and logs read as printed
 * instead of JSON-escaped. A wrapper's `execute` may return another value: a
 * string stays text, and any other shape stays JSON.
 */
function bashModelOutput(output: unknown): ToolModelOutput {
  if (typeof output === "string") return toolOutput.text(output);
  if (!isBashResult(output)) return toolOutput.json(output);
  const streams = [output.stdout, output.stderr && `[stderr]\n${output.stderr}`]
    .filter((text) => text.length > 0)
    .map((text) => (text.endsWith("\n") ? text : `${text}\n`));
  const status = output.status === "running" ? output.message : `[exit code: ${output.exitCode}]`;
  return toolOutput.text(`${streams.join("\n")}${status}`);
}

/** A `bash` result with no extra keys and the fields its status requires. */
function isBashResult(output: unknown): output is BashToolOutput {
  if (typeof output !== "object" || output === null) return false;
  const value = output as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => BASH_OUTPUT_KEYS.has(key)) &&
    typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    ((value.status === "completed" && typeof value.exitCode === "number") ||
      (value.status === "running" && typeof value.message === "string"))
  );
}

export default bash;
