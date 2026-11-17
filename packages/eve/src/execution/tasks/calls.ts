import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

export const TASK_WAIT_DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

export type TaskToolCall =
  | {
      readonly callId: string;
      readonly kind: typeof TASK_WAIT_TOOL_NAME;
      readonly timeoutMs: number;
    }
  | {
      readonly callId: string;
      readonly kind: typeof TASK_CANCEL_TOOL_NAME;
      readonly taskId: string;
    };

export function pendingTaskToolCalls(messages: readonly ModelMessage[]): TaskToolCall[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  const calls: TaskToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || answered.has(part.toolCallId)) continue;
      const input = typeof part.input === "object" && part.input !== null ? part.input : {};
      if (part.toolName === TASK_CANCEL_TOOL_NAME) {
        const taskId = String(Reflect.get(input, "taskId"));
        calls.push({ callId: part.toolCallId, kind: TASK_CANCEL_TOOL_NAME, taskId });
      } else if (part.toolName === TASK_WAIT_TOOL_NAME) {
        const timeoutSeconds: unknown = Reflect.get(input, "timeoutSeconds");
        calls.push({
          callId: part.toolCallId,
          kind: TASK_WAIT_TOOL_NAME,
          timeoutMs:
            typeof timeoutSeconds === "number"
              ? timeoutSeconds * 1_000
              : TASK_WAIT_DEFAULT_TIMEOUT_MS,
        });
      }
    }
  }
  return calls;
}

export type TaskWaitResult =
  | {
      readonly status: "settled";
      readonly settled: readonly {
        readonly id: string;
        readonly status: "completed" | "failed";
      }[];
      readonly working: readonly string[];
    }
  | { readonly status: "timeout" | "interrupt"; readonly working: readonly string[] };

export interface TaskCancelResult {
  readonly resumable: boolean;
  readonly status: "cancelled" | "already_finished";
  readonly tool: string;
}

export function taskToolResult(
  callId: string,
  toolName: string,
  output: JsonValue,
): RuntimeToolResultActionResult {
  return { callId, kind: "tool-result", output, toolName };
}
