import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import { TASK_CANCEL_TOOL_NAME, TASK_WAIT_TOOL_NAME } from "#protocol/task-tools.js";

/**
 * Calls to the task tools. They defer out of the model step like
 * workflow tool calls; the session answers them instead of a workflow run.
 */
export type TaskToolCall =
  | {
      readonly callId: string;
      readonly kind: typeof TASK_WAIT_TOOL_NAME;
      readonly timeoutMs?: number;
    }
  | {
      readonly callId: string;
      readonly kind: typeof TASK_CANCEL_TOOL_NAME;
      readonly taskId: string;
    };

/**
 * The task tool calls a parked step's response still waits on. The response
 * is the one record of these calls: a call without a result is pending, and
 * a call with invalid input already carries its error result. The `eve`
 * namespace is reserved, so no authored tool's call matches.
 */
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
        // Seconds, to match `sleep`.
        const timeoutSeconds: unknown = Reflect.get(input, "timeoutSeconds");
        calls.push(
          typeof timeoutSeconds === "number"
            ? {
                callId: part.toolCallId,
                kind: TASK_WAIT_TOOL_NAME,
                timeoutMs: timeoutSeconds * 1_000,
              }
            : { callId: part.toolCallId, kind: TASK_WAIT_TOOL_NAME },
        );
      }
    }
  }
  return calls;
}

/** Why an `eve__task_wait` call, or a held turn, stopped waiting. */
export type TaskWaitResult =
  | {
      readonly status: "settled";
      /** Tasks whose results follow; both lists are empty when nothing was working. */
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

// Built directly: the workflow body can't import the harness's result helpers.
export function taskToolResult(
  callId: string,
  toolName: string,
  output: JsonValue,
): RuntimeToolResultActionResult {
  return { callId, kind: "tool-result", output, toolName };
}
