import { z } from "#compiled/zod/index.js";

import type { SessionContext } from "#context/session-context.js";
import {
  DEFAULT_BASH_YIELD_TIME_MS,
  executeBashOnSandbox,
  formatBashOutput,
  getBackgroundBashProcess,
  waitForBackgroundBashProcess,
  type BashInput,
} from "#execution/sandbox/bash.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";

const YIELD_TIME_SCHEMA = z
  .number()
  .nonnegative()
  .describe(
    `Maximum time in milliseconds to wait before returning a process id for a still-running command. Defaults to ${DEFAULT_BASH_YIELD_TIME_MS} ms.`,
  )
  .optional();

export type BashToolInput =
  | { readonly action?: "run"; readonly command: string; readonly yieldTimeMs?: number }
  | {
      readonly action: "poll" | "wait" | "kill";
      readonly processId: string;
      readonly yieldTimeMs?: number;
    };

export const BASH_INPUT_SCHEMA = z
  .strictObject({
    action: z
      .enum(["run", "poll", "wait", "kill"])
      .describe("Run a new command, read process output, wait longer, or terminate a process.")
      .default("run"),
    command: z
      .string()
      .describe("Required with action run: the shell command to execute.")
      .optional(),
    processId: z
      .string()
      .describe("Required with action poll, wait, or kill: the id returned by an earlier call.")
      .optional(),
    yieldTimeMs: YIELD_TIME_SCHEMA,
  })
  .superRefine((input, context) => {
    const invalid =
      input.action === "run"
        ? input.command === undefined || input.processId !== undefined
        : input.command !== undefined || input.processId === undefined;
    if (invalid) {
      context.addIssue({
        code: "custom",
        message: "Action run requires command; other actions require processId.",
      });
    }
  })
  .describe("Choose an action, then provide its command or processId.")
  .meta({ required: ["action"] }) as z.ZodType<BashToolInput>;

const BASH_OUTPUT_FIELDS = {
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
  wallTimeSeconds: z
    .number()
    .describe("Elapsed wall time this call spent before returning, in seconds."),
};

export const BASH_OUTPUT_SCHEMA = z.discriminatedUnion("status", [
  z.strictObject({
    ...BASH_OUTPUT_FIELDS,
    exitCode: z.number(),
    status: z.literal("completed"),
  }),
  z.strictObject({ ...BASH_OUTPUT_FIELDS, status: z.literal("killed") }),
  z.strictObject({
    ...BASH_OUTPUT_FIELDS,
    processId: z.string(),
    status: z.literal("running"),
  }),
]);

export type BashToolOutput = z.infer<typeof BASH_OUTPUT_SCHEMA>;

export async function executeBashTool(
  input: BashToolInput,
  context: Pick<SessionContext, "getSandbox"> & { readonly abortSignal: AbortSignal },
): Promise<BashToolOutput> {
  const sandbox = await context.getSandbox();
  if ("command" in input) {
    return await executeBashOnSandbox(sandbox, input as BashInput, {
      abortSignal: context.abortSignal,
    });
  }

  const startedAt = Date.now();
  const process = getBackgroundBashProcess(sandbox, input.processId);
  if (input.action === "kill") {
    const before = await process.read();
    if (before.exitCode !== undefined) {
      const output = formatBashOutput(before.stdout, before.stderr, startedAt);
      return { ...output, exitCode: before.exitCode, status: "completed" };
    }
    await process.kill();
    return { ...formatBashOutput(before.stdout, before.stderr, startedAt), status: "killed" };
  }
  if (input.action === "wait") {
    await waitForBackgroundBashProcess({
      abortSignal: context.abortSignal,
      process,
      yieldTimeMs: input.yieldTimeMs ?? DEFAULT_BASH_YIELD_TIME_MS,
    });
  }
  const state = await process.read();
  if (state.exitCode === undefined) {
    return {
      ...formatBashOutput(state.stdout, state.stderr, startedAt),
      processId: process.processId,
      status: "running",
    };
  }
  return {
    ...formatBashOutput(state.stdout, state.stderr, startedAt),
    exitCode: state.exitCode,
    status: "completed",
  };
}

export const bash: ToolDefinition<BashToolInput, BashToolOutput> = defineTool({
  description: [
    "Run shell commands and manage commands that continue in the background.",
    `Use action run with command for a new command; it waits up to ${DEFAULT_BASH_YIELD_TIME_MS} ms by default, then returns a process id if still running.`,
    "Pass that process id back with action poll, wait, or kill.",
  ].join(" "),
  execute: executeBashTool,
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
});

export default bash;
