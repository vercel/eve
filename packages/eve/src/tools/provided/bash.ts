import { z } from "#compiled/zod/index.js";

import type { SessionContext } from "#context/session-context.js";
import {
  DEFAULT_BASH_YIELD_AFTER_SECONDS,
  executeBashOnSandbox,
  formatBashOutput,
  type BashInput,
} from "#execution/sandbox/bash.js";
import {
  getBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "#execution/sandbox/bash-background.js";
import { defineTool, type ToolDefinition } from "#tools/definition.js";

const YIELD_AFTER_SCHEMA = z
  .number()
  .nonnegative()
  .describe(`Optional foreground wait in seconds. Defaults to ${DEFAULT_BASH_YIELD_AFTER_SECONDS}.`)
  .optional();

export const BASH_INPUT_SCHEMA = z.union([
  z.strictObject({
    command: z.string().describe("The shell command to execute."),
    yieldAfter: YIELD_AFTER_SCHEMA.describe(
      `Optional foreground wait in seconds. Defaults to ${DEFAULT_BASH_YIELD_AFTER_SECONDS}. If the command is still running, bash returns a process id instead of stopping it.`,
    ),
  }),
  z.strictObject({
    action: z.enum(["poll", "wait", "kill"]),
    processId: z.string().describe("The process id returned by an earlier bash call."),
    yieldAfter: YIELD_AFTER_SCHEMA,
  }),
]);

const BASH_OUTPUT_FIELDS = {
  stderr: z.string(),
  stdout: z.string(),
  truncated: z.boolean(),
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

export type BashToolInput = z.infer<typeof BASH_INPUT_SCHEMA>;
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

  const process = getBackgroundBashProcess(sandbox, input.processId);
  if (input.action === "kill") {
    const before = await process.read();
    if (before.exitCode !== undefined) {
      const output = formatBashOutput(before.stdout, before.stderr);
      return { ...output, exitCode: before.exitCode, status: "completed" };
    }
    await process.kill();
    return { ...formatBashOutput(before.stdout, before.stderr), status: "killed" };
  }
  const state =
    input.action === "poll"
      ? await process.read()
      : await waitForBackgroundBashProcess({
          abortSignal: context.abortSignal,
          process,
          yieldAfterMs: (input.yieldAfter ?? DEFAULT_BASH_YIELD_AFTER_SECONDS) * 1_000,
        });
  if (state === null || state.exitCode === undefined) {
    const latest = state ?? (await process.read());
    return {
      ...formatBashOutput(latest.stdout, latest.stderr),
      processId: process.processId,
      status: "running",
    };
  }
  return {
    ...formatBashOutput(state.stdout, state.stderr),
    exitCode: state.exitCode,
    status: "completed",
  };
}

export const bash: ToolDefinition<BashToolInput, BashToolOutput> = defineTool({
  description: [
    "Run shell commands and manage commands that continue in the background.",
    `A new command waits up to ${DEFAULT_BASH_YIELD_AFTER_SECONDS} seconds by default, then returns a process id if still running.`,
    "Pass that process id back with action poll, wait, or kill.",
  ].join(" "),
  execute: executeBashTool,
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA,
});

export default bash;
