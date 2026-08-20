import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";
import type { TaskExec } from "#shared/tool-task.js";

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
  register(call: BackgroundToolCall): void;
}

export interface BackgroundToolExecutor {
  execute(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown>;
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
  const callIds = new Set<string>();
  return {
    calls,
    register(call) {
      if (callIds.has(call.callId)) {
        throw new Error(`Background tool call "${call.callId}" was registered more than once.`);
      }
      callIds.add(call.callId);
      calls.push(call);
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
