import type { ToolExecutionOptions, ToolSet } from "ai";
import { isDeepStrictEqual } from "node:util";
import type * as CodeModeModule from "#compiled/@ai-sdk/code-mode/index.js";

const MODULE_KEY = Symbol.for("eve.codeModeRuntime.module");
const MODULE_SPECIFIER = ["#compiled", "@ai-sdk", "code-mode", "index.js"].join("/");

type RuntimeModule = Pick<
  typeof CodeModeModule,
  "CodeModeToolError" | "experimental_createCodeModeTool" | "experimental_runCodeMode"
>;
type RuntimeGlobal = typeof globalThis & { [MODULE_KEY]?: RuntimeModule };

let modulePromise: Promise<RuntimeModule> | undefined;

export const CODE_MODE_RUNTIME_LIMITS = {
  maxBridgeRequests: 64,
  maxInFlightBridgeRequests: 8,
  timeoutMs: 300_000,
} as const;
export const CODE_MODE_TASK_LAUNCH_LIMIT = 8;

export interface CodeModeTaskLauncher {
  execute(input: unknown, options: ToolExecutionOptions<unknown>): Promise<unknown>;
  readonly mode: "local" | "remote";
  prepare(input: unknown, options: ToolExecutionOptions<unknown>): Promise<void>;
  preview(input: unknown, options: ToolExecutionOptions<unknown>): unknown;
  reserve(programCallId: string, size: number): void;
  rollback(cause: unknown, options: ToolExecutionOptions<unknown>): Promise<void>;
}

interface StagedTaskLaunch {
  readonly input: unknown;
  readonly launcher: CodeModeTaskLauncher;
  readonly options: ToolExecutionOptions<unknown>;
  readonly preview: unknown;
}

export const CODE_MODE_RUNTIME_OPTIONS = {
  executionPolicy: CODE_MODE_RUNTIME_LIMITS,
} as const;

export function installCodeModeRuntimeModule(module: RuntimeModule): void {
  (globalThis as RuntimeGlobal)[MODULE_KEY] = module;
}

export async function createCodeModeRuntimeTool(input: {
  readonly hostTools: ToolSet;
  readonly sourcePrefix?: string;
  readonly taskLaunchers?: ReadonlyMap<string, CodeModeTaskLauncher>;
}): Promise<ToolSet[string]> {
  const { CodeModeToolError, experimental_createCodeModeTool, experimental_runCodeMode } =
    await loadModule();
  const runtimeTool = experimental_createCodeModeTool(
    input.hostTools,
    CODE_MODE_RUNTIME_OPTIONS,
  ) as ToolSet[string];
  if (runtimeTool.execute === undefined) return runtimeTool;

  return {
    ...runtimeTool,
    execute: async (toolInput: { readonly js: string }, options: ToolExecutionOptions<never>) => {
      const deadline = Date.now() + CODE_MODE_RUNTIME_LIMITS.timeoutMs;
      const pending = new Set<Promise<void>>();
      const stagedTaskLaunches: StagedTaskLaunch[] = [];
      reserveTaskLaunchFanout(input.taskLaunchers, options.toolCallId, CODE_MODE_TASK_LAUNCH_LIMIT);
      try {
        const result = await experimental_runCodeMode({
          js:
            input.sourcePrefix === undefined
              ? toolInput.js
              : `${input.sourcePrefix}\n${toolInput.js}`,
          options: CODE_MODE_RUNTIME_OPTIONS,
          toolExecutionOptions: options,
          tools: trackHostTools(
            input.hostTools,
            pending,
            input.taskLaunchers,
            CodeModeToolError,
            stagedTaskLaunches,
          ),
        });
        reserveTaskLaunchFanout(
          input.taskLaunchers,
          options.toolCallId,
          stagedTaskLaunches.filter((launch) => launch.launcher.mode === "local").length,
        );
        await executeStagedTaskLaunches(stagedTaskLaunches, options.abortSignal);
        return result;
      } catch (error) {
        reserveTaskLaunchFanout(input.taskLaunchers, options.toolCallId, 0);
        throw error;
      } finally {
        await settleStartedHostExecutions(pending, deadline);
      }
    },
  } as ToolSet[string];
}

function reserveTaskLaunchFanout(
  launchers: ReadonlyMap<string, CodeModeTaskLauncher> | undefined,
  programCallId: string,
  size: number,
): void {
  for (const launcher of new Set(launchers?.values())) {
    if (launcher.mode === "local") launcher.reserve(programCallId, size);
  }
}

function trackHostTools(
  tools: ToolSet,
  pending: Set<Promise<void>>,
  taskLaunchers: ReadonlyMap<string, CodeModeTaskLauncher> | undefined,
  CodeModeToolError: typeof CodeModeModule.CodeModeToolError,
  stagedTaskLaunches: StagedTaskLaunch[],
): ToolSet {
  let taskLaunchCount = 0;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (execute === undefined) return [name, tool];
      return [
        name,
        {
          ...tool,
          execute: (input: never, options: never) => {
            const taskLauncher = taskLaunchers?.get(name);
            if (taskLauncher !== undefined) {
              taskLaunchCount += 1;
              if (taskLaunchCount > CODE_MODE_TASK_LAUNCH_LIMIT) {
                return Promise.reject(
                  new CodeModeToolError(
                    `Code mode may launch at most ${CODE_MODE_TASK_LAUNCH_LIMIT} background tasks per program.`,
                  ),
                );
              }
              try {
                const preview = taskLauncher.preview(input, options);
                stagedTaskLaunches.push({ input, launcher: taskLauncher, options, preview });
                return Promise.resolve(preview);
              } catch (error) {
                return Promise.reject(error);
              }
            }
            const execution = Promise.resolve().then(async () => {
              return await execute(input, options);
            });
            const settled = execution.then(
              () => undefined,
              () => undefined,
            );
            pending.add(settled);
            void settled.finally(() => pending.delete(settled));
            return execution;
          },
        },
      ];
    }),
  ) as ToolSet;
}

async function executeStagedTaskLaunches(
  staged: readonly StagedTaskLaunch[],
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (staged.length === 0) return;
  for (const launch of staged) await launch.launcher.prepare(launch.input, launch.options);
  if (abortSignal?.aborted === true) throw abortSignal.reason;
  const settled = staged.map(() => false);
  let aborted = false;
  let abortReason: unknown;
  let settledAtAbort: readonly boolean[] | undefined;
  const onAbort = () => {
    aborted = true;
    abortReason = abortSignal?.reason;
    settledAtAbort = [...settled];
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  const outcomes = await Promise.allSettled(
    staged.map((launch, index) =>
      launch.launcher.execute(launch.input, launch.options).finally(() => {
        settled[index] = true;
      }),
    ),
  );
  abortSignal?.removeEventListener("abort", onAbort);
  if (aborted) {
    const lateLaunches = staged.filter((_launch, index) => settledAtAbort?.[index] !== true);
    await rollbackStagedTaskLaunches(lateLaunches, abortReason);
    throw abortReason;
  }
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed !== undefined) {
    await rollbackStagedTaskLaunches(staged, failed.reason);
    throw failed.reason;
  }
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    const launch = staged[index];
    if (outcome?.status !== "fulfilled" || launch === undefined) continue;
    if (!isDeepStrictEqual(outcome.value, launch.preview)) {
      const mismatch = new Error(
        "A staged task launch returned a receipt that did not match its preview.",
      );
      await rollbackStagedTaskLaunches(staged, mismatch);
      throw mismatch;
    }
  }
}

async function rollbackStagedTaskLaunches(
  staged: readonly StagedTaskLaunch[],
  cause: unknown,
): Promise<void> {
  const rollbacks = await Promise.allSettled(
    staged.map((launch) => launch.launcher.rollback(cause, launch.options)),
  );
  const failures = rollbacks.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      [cause, ...failures],
      "Staged task launches failed and could not all be compensated.",
      { cause },
    );
  }
}

async function settleStartedHostExecutions(
  pending: Set<Promise<void>>,
  deadline: number,
): Promise<void> {
  while (pending.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, remainingMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

/** Uses the installed runtime's renderer rather than maintaining an eve copy. */
export async function renderCodeModeToolSignature(
  name: string,
  hostTool: ToolSet[string],
): Promise<string> {
  const { experimental_createCodeModeTool } = await loadModule();
  const description = experimental_createCodeModeTool({ [name]: hostTool }).description;
  if (typeof description !== "string") {
    throw new Error(`The code-mode runtime could not render a signature for tool "${name}".`);
  }
  const marker = "declare const tools: {\n";
  const start = description.indexOf(marker);
  const end = description.indexOf("\n};", start + marker.length);
  if (start < 0 || end < 0) {
    throw new Error(`The code-mode runtime could not render a signature for tool "${name}".`);
  }
  return description.slice(start + marker.length, end);
}

export async function codeModeToolError(message: string): Promise<Error> {
  const { CodeModeToolError } = await loadModule();
  return new CodeModeToolError(message);
}

async function loadModule(): Promise<RuntimeModule> {
  const installed = (globalThis as RuntimeGlobal)[MODULE_KEY];
  if (installed !== undefined) return installed;
  modulePromise ??= import(MODULE_SPECIFIER) as Promise<RuntimeModule>;
  return await modulePromise;
}
