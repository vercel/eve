import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { HarnessSession } from "#harness/types.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";

export interface BackgroundExecutableTool {
  readonly execute: (input: unknown, options: ToolExecuteOptions, task: TaskExec) => unknown;
  readonly name: string;
}

export interface BackgroundToolCall {
  readonly callId: string;
  readonly definition: BackgroundExecutableTool;
  readonly input: unknown;
}

export interface BackgroundToolCallBatch {
  readonly calls: readonly BackgroundToolCall[];
  register(call: {
    readonly callId: string;
    readonly input: unknown;
    readonly toolName: string;
  }): void;
  setTool(name: string, definition?: BackgroundExecutableTool): void;
}

export interface BackgroundToolExecutor {
  execute(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown>;
  rollbackCalls?(input: {
    readonly callIds: ReadonlySet<string>;
    readonly cause: unknown;
  }): Promise<void>;
}

export interface SubagentTaskLauncher {
  readonly mode: "local" | "remote";
  preview(input: {
    readonly callId: string;
    readonly session: HarnessSession;
    readonly toolInput: unknown;
    readonly turnId: string;
  }): {
    readonly agentId: string;
    readonly status: "working";
    readonly taskId: string;
  };
}

const subagentTaskLaunchers = new WeakMap<object, SubagentTaskLauncher>();
const localFanoutReservations = new WeakMap<readonly BackgroundToolCall[], Map<string, number>>();
const stagedBackgroundCallIds = new WeakMap<readonly BackgroundToolCall[], Set<string>>();

export function registerSubagentTaskLauncher(
  execute: object,
  launcher: SubagentTaskLauncher,
): void {
  subagentTaskLaunchers.set(execute, launcher);
}

export function readSubagentTaskLauncher(
  execute: object | undefined,
): SubagentTaskLauncher | undefined {
  return execute === undefined ? undefined : subagentTaskLaunchers.get(execute);
}

export function reserveLocalSubagentFanout(
  calls: readonly BackgroundToolCall[],
  reservationId: string,
  size: number,
): void {
  let reservations = localFanoutReservations.get(calls);
  if (reservations === undefined) {
    reservations = new Map();
    localFanoutReservations.set(calls, reservations);
  }
  reservations.set(reservationId, size);
}

export function markStagedBackgroundCall(
  calls: readonly BackgroundToolCall[],
  callId: string,
): void {
  let callIds = stagedBackgroundCallIds.get(calls);
  if (callIds === undefined) {
    callIds = new Set();
    stagedBackgroundCallIds.set(calls, callIds);
  }
  callIds.add(callId);
}

export function readReservedLocalSubagentFanout(
  calls: readonly { readonly callId?: string; readonly definition: { readonly execute: object } }[],
): number | undefined {
  const backgroundCalls = calls as readonly BackgroundToolCall[];
  const reservations = localFanoutReservations.get(backgroundCalls);
  if (reservations === undefined) return undefined;
  const stagedCallIds = stagedBackgroundCallIds.get(backgroundCalls);
  const directLocalCalls = calls.filter(
    (call) =>
      (call.callId === undefined || stagedCallIds?.has(call.callId) !== true) &&
      readSubagentTaskLauncher(call.definition.execute)?.mode === "local",
  ).length;
  return directLocalCalls + [...reservations.values()].reduce((total, size) => total + size, 0);
}

// A ContextKey rather than a direct import of the task runtime, for three reasons:
// 1. The executor is per-step state, not a module export — each task-runtime step
//    installs a fresh instance whose commit/rollback rides that step's transaction,
//    so the correct instance can only be resolved at call time.
// 2. Importing the implementation from `execution/` would make the harness ↔
//    execution dependency bidirectional; the key keeps it one-way (harness declares
//    the contract, execution installs it).
// 3. "No task runtime active" stays a runtime condition instead of a link-time one:
//    tool sets can be built anywhere, and `require()` only throws if a background
//    call actually fires outside a task step.
export const BackgroundToolExecutorKey = new ContextKey<BackgroundToolExecutor>(
  "eve.internal.backgroundToolExecution",
);

export function createBackgroundToolCallBatch(): BackgroundToolCallBatch {
  const calls: BackgroundToolCall[] = [];
  const callsById = new Map<string, BackgroundToolCall>();
  const tools = new Map<string, BackgroundExecutableTool>();
  return {
    calls,
    register(call) {
      const definition = tools.get(call.toolName);
      if (definition === undefined) return;

      const existing = callsById.get(call.callId);
      if (existing?.definition === definition) return;
      if (existing !== undefined) {
        throw new Error(`Background tool call "${call.callId}" was registered more than once.`);
      }

      const registeredCall = { callId: call.callId, definition, input: call.input };
      callsById.set(call.callId, registeredCall);
      calls.push(registeredCall);
    },
    setTool(name, definition) {
      if (definition === undefined) {
        tools.delete(name);
      } else {
        tools.set(name, definition);
      }
    },
  };
}

export async function executeBackgroundToolCall(input: {
  readonly batch: BackgroundToolCallBatch;
  readonly definition: BackgroundExecutableTool;
  readonly options: ToolExecuteOptions;
  readonly toolInput: unknown;
}): Promise<unknown> {
  return await loadContext().require(BackgroundToolExecutorKey).execute(input);
}

export async function rollbackBackgroundToolCalls(input: {
  readonly batch: BackgroundToolCallBatch;
  readonly callIds: ReadonlySet<string>;
  readonly cause: unknown;
}): Promise<void> {
  if (input.callIds.size === 0) return;
  const executor = loadContext().require(BackgroundToolExecutorKey);
  const rollbackCalls = executor.rollbackCalls;
  if (rollbackCalls === undefined) {
    throw new Error("The background tool executor does not support nested rollback.");
  }
  await rollbackCalls.call(executor, { callIds: input.callIds, cause: input.cause });
}
