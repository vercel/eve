import { executeBashOnSandbox, type BashInput } from "#execution/sandbox/bash.js";
import { BASH_JOB_YIELD_SECONDS } from "#execution/sandbox/bash-jobs.js";
import { toolLabel } from "#tools/tool-label.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

export interface BashToolInput {
  command: string;
}

/**
 * Output of the provided `bash` tool. A command that finishes within 30
 * seconds is `completed`. A longer command keeps running in the sandbox as a
 * job and returns `running` with its output so far; later `bash` calls run
 * `eve-job wait <jobId>` or `eve-job stop <jobId>` to observe or stop it.
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
      jobId: string;
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
  type: "object",
  properties: {
    status: { type: "string", enum: ["completed", "running"] },
    exitCode: { type: "number" },
    jobId: { type: "string" },
    message: { type: "string" },
    stderr: { type: "string" },
    stdout: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["status", "stderr", "stdout", "truncated"],
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
  description: `Execute a shell command in the shared workspace environment. A command still running after ${BASH_JOB_YIELD_SECONDS} seconds keeps running in the background and returns status "running" with instructions to check on or stop it.`,
  async execute(input, ctx) {
    return await executeBashOnSandbox(await ctx.getSandbox(), input as BashInput, {
      jobKey: `${ctx.session.id}/${ctx.callId}`,
    });
  },
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
});

export default bash;
