import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";

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
  readonly subagentCalls: readonly {
    readonly callId: string;
    readonly input: unknown;
    readonly kind: "local" | "remote";
  }[];
  register(call: {
    readonly callId: string;
    readonly input: unknown;
    readonly toolName: string;
  }): void;
  setTool(name: string, definition?: BackgroundExecutableTool): void;
  setSubagent(name: string, kind?: "local" | "remote"): void;
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
  const callsById = new Map<string, BackgroundToolCall>();
  const tools = new Map<string, BackgroundExecutableTool>();
  const subagentCalls: Array<{
    readonly callId: string;
    readonly input: unknown;
    readonly kind: "local" | "remote";
  }> = [];
  const subagentCallsById = new Set<string>();
  const subagents = new Map<string, "local" | "remote">();
  return {
    calls,
    subagentCalls,
    register(call) {
      const subagentKind = subagents.get(call.toolName);
      if (subagentKind !== undefined && !subagentCallsById.has(call.callId)) {
        subagentCallsById.add(call.callId);
        subagentCalls.push({ callId: call.callId, input: call.input, kind: subagentKind });
      }
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
    setSubagent(name, kind) {
      if (kind === undefined) subagents.delete(name);
      else subagents.set(name, kind);
    },
  };
}

export function countFreshLocalSubagentCalls(
  batch: Pick<BackgroundToolCallBatch, "subagentCalls">,
  session: HarnessSession,
): number {
  const knownIds = new Set(
    (getAgentHandleStore(session.state)?.handles ?? []).map((handle) => handle.identity.id),
  );
  return batch.subagentCalls.filter((call) => {
    if (call.kind !== "local") return false;
    const agentId =
      call.input !== null && typeof call.input === "object"
        ? (call.input as { readonly agentId?: unknown }).agentId
        : undefined;
    return typeof agentId !== "string" || agentId.trim() === "" || !knownIds.has(agentId);
  }).length;
}

export async function executeBackgroundToolCall(input: {
  readonly batch: BackgroundToolCallBatch;
  readonly definition: BackgroundExecutableTool;
  readonly options: ToolExecuteOptions;
  readonly toolInput: unknown;
}): Promise<unknown> {
  return await loadContext().require(BackgroundToolExecutorKey).execute(input);
}
