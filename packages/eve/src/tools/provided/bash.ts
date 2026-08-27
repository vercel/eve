import { z } from "#compiled/zod/index.js";

import type { SessionContext } from "#context/session-context.js";
import {
  activateBashCompletionMonitor,
  closeBashCompletionMonitor,
  killBashCompletionMonitor,
  startBashCompletionMonitor,
  type BashCompletionMonitorHandle,
} from "#execution/sandbox/bash-completion.js";
import {
  DEFAULT_BASH_RUN_YIELD_TIME_MS,
  DEFAULT_BASH_WAIT_YIELD_TIME_MS,
  executeBashOnSandbox,
  formatBashOutput,
  getBackgroundBashProcess,
  resolveBashInlineWaitMs,
  supportsDurableBashCompletion,
  waitForBackgroundBashProcess,
  type BashInput,
} from "#execution/sandbox/bash.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";

const YIELD_TIME_SCHEMA = z
  .number()
  .nonnegative()
  .describe(
    `Requested time in milliseconds to wait before returning. Every inline wait is capped at ${DEFAULT_BASH_RUN_YIELD_TIME_MS} ms and may yield earlier near the current Function deadline.`,
  )
  .nullable()
  .optional();

type BashProcessToolInput = {
  readonly action: "poll" | "wait" | "kill";
  readonly processId: string;
  readonly yieldTimeMs?: number;
};

export type BashToolInput =
  | { readonly action?: "run"; readonly command: string; readonly yieldTimeMs?: number }
  | BashProcessToolInput;

export const BASH_INPUT_SCHEMA = z
  .strictObject({
    action: z
      .enum(["run", "poll", "wait", "kill"])
      .describe("Run a new command, read process output, wait longer, or terminate a process.")
      .default("run"),
    command: z
      .string()
      .describe("Required with action run: the shell command to execute.")
      .nullable()
      .optional(),
    processId: z
      .string()
      .describe("Required with action poll, wait, or kill: the id returned by an earlier call.")
      .nullable()
      .optional(),
    yieldTimeMs: YIELD_TIME_SCHEMA,
  })
  .superRefine((input, context) => {
    const hasCommand = typeof input.command === "string" && input.command !== "";
    const hasProcessId = typeof input.processId === "string" && input.processId !== "";
    const invalid =
      input.action === "run" ? !hasCommand || hasProcessId : hasCommand || !hasProcessId;
    if (invalid) {
      context.addIssue({
        code: "custom",
        message: "Action run requires command; other actions require processId.",
      });
    }
  })
  .describe("Choose an action, then provide its command or processId.")
  .meta({
    required: ["action", "command", "processId", "yieldTimeMs"],
  }) as z.ZodType<BashToolInput>;

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
  context: Pick<SessionContext, "getSandbox"> & {
    readonly abortSignal: AbortSignal;
    readonly session: Pick<SessionContext["session"], "id">;
    readonly callId: string;
  },
): Promise<BashToolOutput> {
  const sandbox = await context.getSandbox();
  if (input.action === undefined || input.action === "run") {
    let monitor: BashCompletionMonitorHandle | undefined;
    const result = await executeBashOnSandbox(sandbox, input as BashInput, {
      abortSignal: context.abortSignal,
      idempotencyKey: `${context.session.id}:${context.callId}`,
      onStarted: async (process) => {
        monitor = await startBashCompletionMonitor({
          processId: process.commandId,
          sessionId: context.session.id,
        });
      },
    });
    if (monitor !== undefined) {
      if (result.status === "running") {
        await activateBashCompletionMonitor(monitor);
      } else {
        await closeBashCompletionMonitor(monitor);
      }
    }
    return result;
  }

  const processInput = input as BashProcessToolInput;
  const startedAt = Date.now();
  const process = await getBackgroundBashProcess(sandbox, processInput.processId);
  if (processInput.action === "kill") {
    if (supportsDurableBashCompletion(sandbox)) {
      const monitored = await killBashCompletionMonitor({
        processId: processInput.processId,
        sessionId: context.session.id,
        timeoutMs: resolveBashInlineWaitMs(DEFAULT_BASH_WAIT_YIELD_TIME_MS),
      });
      if (monitored?.status === "killed" || monitored?.status === "completed") {
        const output = formatBashOutput(
          monitored.observation.stdout,
          monitored.observation.stderr,
          startedAt,
          monitored.observation.truncated,
        );
        return monitored.status === "completed"
          ? { ...output, exitCode: monitored.observation.exitCode!, status: "completed" }
          : { ...output, status: "killed" };
      }
    }
    const before = await process.inspect();
    if (before.exitCode !== undefined) {
      const output = formatBashOutput(before.stdout, before.stderr, startedAt, before.truncated);
      return { ...output, exitCode: before.exitCode, status: "completed" };
    }
    await process.terminate();
    return {
      ...formatBashOutput(before.stdout, before.stderr, startedAt, before.truncated),
      status: "killed",
    };
  }
  if (processInput.action === "wait") {
    const yieldTimeMs = resolveBashInlineWaitMs(
      processInput.yieldTimeMs ?? DEFAULT_BASH_WAIT_YIELD_TIME_MS,
    );
    if (yieldTimeMs === 0) {
      context.abortSignal.throwIfAborted();
    } else {
      await waitForBackgroundBashProcess({
        abortSignal: context.abortSignal,
        process,
        yieldTimeMs,
      });
    }
  }
  const state = await process.inspect();
  if (state.exitCode === undefined) {
    return {
      ...formatBashOutput(state.stdout, state.stderr, startedAt, state.truncated),
      processId: process.commandId,
      status: "running",
    };
  }
  return {
    ...formatBashOutput(state.stdout, state.stderr, startedAt, state.truncated),
    exitCode: state.exitCode,
    status: "completed",
  };
}

export const bash: ToolDefinition<BashToolInput, BashToolOutput> = defineTool({
  description: [
    "Run shell commands and manage commands that continue in the background.",
    `Use action run with command for a new command; it waits up to ${DEFAULT_BASH_RUN_YIELD_TIME_MS} ms by default, then returns a process id if still running.`,
    `Pass that process id back with action poll, wait, or kill; every inline wait is capped at ${DEFAULT_BASH_WAIT_YIELD_TIME_MS} ms and may yield earlier near the Function deadline.`,
    "On reconnectable backends, a yielded command sends its completion as a new session message; polling is not required.",
  ].join(" "),
  execute: executeBashTool,
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
});

export default bash;
