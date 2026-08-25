import type { ChannelAdapter } from "#channel/adapter.js";
import { SessionCallbackKey } from "#context/keys.js";
import { fireTaskUpdateCallbackStep } from "#execution/session-callback-step.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
} from "#execution/subagent-adapter-state.js";
import { createTaskControlError } from "#execution/tasks/parent/control-shared.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#shared/action-types.js";
import { readTaskIdFromInboxToken } from "#tasks/task-id.js";
import type { TaskInboundUpdate } from "#tasks/types.js";

/** Sends one child-authored progress update over its existing parent transport. */
export async function executeTaskUpdate(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly adapter: ChannelAdapter | undefined;
  readonly updateIndex: number;
  readonly updateEpoch: string;
  readonly serializedContext: Record<string, unknown> | undefined;
}): Promise<RuntimeActionResult> {
  const message = readUpdateMessage(input.action.input);
  if (message === undefined) {
    return createTaskControlError(input.action, "Provide a non-empty `message`.");
  }

  const callback = input.serializedContext?.[SessionCallbackKey.name];
  if (callback !== undefined) {
    const taskId = await fireTaskUpdateCallbackStep({
      callback,
      callId: input.action.callId,
      updateIndex: input.updateIndex,
      updateEpoch: input.updateEpoch,
      message,
    });
    if (taskId === undefined) {
      return createTaskControlError(input.action, "This session is not owned by a parent task.");
    }
    return createTaskUpdateResult(input.action, taskId);
  }

  const adapter = input.adapter;
  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND || !isSubagentAdapterState(adapter.state)) {
    return createTaskControlError(input.action, "This session is not owned by a parent task.");
  }
  const token = adapter.state.parentContinuationToken;
  const taskId = readTaskIdFromInboxToken(token);
  if (taskId === undefined) {
    return createTaskControlError(input.action, "This session is not owned by a parent task.");
  }
  const update: TaskInboundUpdate = {
    callId: input.action.callId,
    updateIndex: input.updateIndex,
    updateEpoch: input.updateEpoch,
    kind: "task-update",
    message,
  };
  await resumeHook(token, update);
  return createTaskUpdateResult(input.action, taskId);
}

function readUpdateMessage(input: Record<string, unknown>): string | undefined {
  return typeof input.message === "string" && input.message.trim() !== ""
    ? input.message
    : undefined;
}

function createTaskUpdateResult(
  action: RuntimeToolCallActionRequest,
  taskId: string,
): RuntimeActionResult {
  return {
    callId: action.callId,
    kind: "tool-result",
    output: { status: "sent", taskId },
    toolName: action.toolName,
  };
}
