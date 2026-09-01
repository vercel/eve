import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { TaskExec } from "#tools/task.js";
import type { AgentView } from "#subagents/handles/prompt.js";
import type { JsonValue } from "#shared/json.js";

export interface BackgroundExecutableTool {
  readonly execute: (input: unknown, options: ToolExecuteOptions, task: TaskExec) => unknown;
  readonly name: string;
  /** Present when the execute body runs in the task-owned durable workflow. */
  readonly task?: {
    readonly executeInput?: (input: unknown) => JsonValue;
    readonly nodeId?: string;
    readonly resultKind?: "subagent" | "tool";
    readonly workflowId: string;
  };
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
  readAgentViews?(): Promise<readonly AgentView[]>;
  execute(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown>;
}

// A ContextKey rather than a direct import of the task runtime, for three reasons:
// 1. The executor is per-step state, not a module export, so the correct
//    transaction and session-owned agent handle store can only be resolved at call time.
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
