import {
  BASH_MAX_YIELD_SECONDS,
  BASH_YIELD_SECONDS,
  executeBashToolOnSandbox,
  type BashInput,
} from "#execution/sandbox/bash.js";
import { frameworkTool } from "./framework-tool.js";
import { toolOutput, type ToolModelOutput } from "#tools/model-output.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

/** Input to the provided `bash` tool: the command to run and how long to wait for it. */
export interface BashToolInput {
  command: string;
  /**
   * Seconds to wait. Explicit values up to 120 kill the command on expiry;
   * omitting it (default 60) or passing > 120 continues in a background task.
   */
  timeout?: number;
}

/**
 * Output of the provided `bash` tool. Commands that finish in time or expire
 * under an explicit `timeout` up to 120s return `completed` (exit 124 on
 * timeout). Longer commands promote to a background task during a turn, or
 * return `running` with `pid` and `outputDirectory` outside a promotable turn.
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
    timeout: {
      type: "number",
      description: `Seconds to wait. Explicit values up to ${BASH_MAX_YIELD_SECONDS} kill the command on expiry; omit (default ${BASH_YIELD_SECONDS}s) or pass >${BASH_MAX_YIELD_SECONDS} to continue as a background task.`,
    },
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
    description: `Execute a shell command in the workspace. Pass an explicit \`timeout\` (up to ${BASH_MAX_YIELD_SECONDS}s) to kill the command if it exceeds that limit, or omit \`timeout\` (default ${BASH_YIELD_SECONDS}s foreground wait) / pass >${BASH_MAX_YIELD_SECONDS}s so long-running commands continue as a background task whose result is delivered when it finishes. Returns stdout, then any stderr under \`[stderr]\` (or \`(no output)\`); non-zero exits end with \`[exit code: N]\`.`,
    async execute(input, ctx) {
      const bashInput = input as BashInput;
      const onTimeout =
        bashInput.timeout !== undefined &&
        Number.isFinite(bashInput.timeout) &&
        bashInput.timeout <= BASH_MAX_YIELD_SECONDS
          ? "kill"
          : "background";
      return await executeBashToolOnSandbox(await ctx.getSandbox(), bashInput, {
        abortSignal: ctx.abortSignal,
        onTimeout,
      });
    },
    inputSchema: BASH_INPUT_SCHEMA,
    outputSchema: BASH_OUTPUT_SCHEMA,
    toModelOutput: bashModelOutput,
  }),
);

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
 * instead of JSON-escaped. Like pi, a successful command shows only its
 * output, and a non-zero exit is an error result that ends with its code. A
 * wrapper's `execute` may return another value: a string stays text, and any
 * other shape stays JSON.
 */
function bashModelOutput(output: unknown): ToolModelOutput {
  if (typeof output === "string") return toolOutput.text(output);
  if (!isBashResult(output)) return toolOutput.json(output);
  const text = [output.stdout, output.stderr && `[stderr]\n${output.stderr}`]
    .filter((stream) => stream.length > 0)
    .map((stream) => (stream.endsWith("\n") ? stream : `${stream}\n`))
    .join("\n");
  if (output.status === "running") return toolOutput.text(`${text}${output.message}`);
  if (output.exitCode !== 0) return toolOutput.errorText(`${text}[exit code: ${output.exitCode}]`);
  return toolOutput.text(text === "" ? "(no output)" : text);
}

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
