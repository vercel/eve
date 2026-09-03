import { jsonValuesEqual } from "#shared/json.js";
import {
  isTerminalTaskStatus,
  readTaskInputRequestId,
  type TaskCommand,
  type TaskInputRequest,
  type TaskOutput,
  type TaskUsage,
  type TaskView,
} from "#tasks/types.js";

export type TaskTransitionResult =
  | { readonly action: "accepted"; readonly view: TaskView }
  | { readonly action: "noop"; readonly view: TaskView }
  | { readonly action: "rejected"; readonly view: TaskView; readonly reason: string };

function terminalView(
  view: TaskView,
  command: Extract<TaskCommand, { kind: "complete" | "fail" | "reject-dispatch" | "cancel" }>,
  settled:
    | { readonly lastOutput: Extract<TaskOutput, { type: "result" }>; readonly status: "completed" }
    | { readonly lastOutput: Extract<TaskOutput, { type: "error" }>; readonly status: "failed" }
    | { readonly status: "cancelled" },
): TaskView {
  const usage = "usage" in command ? command.usage : undefined;
  const base: Pick<TaskView, "executor" | "metadata" | "state" | "taskId"> & { usage?: TaskUsage } =
    {
      executor: view.executor,
      metadata: view.metadata,
      state: view.state,
      taskId: view.taskId,
    };
  if (usage !== undefined) base.usage = usage;
  switch (settled.status) {
    case "completed":
      return { ...base, lastOutput: settled.lastOutput, status: "completed" };
    case "failed":
      return { ...base, lastOutput: settled.lastOutput, status: "failed" };
    case "cancelled":
      return { ...base, status: "cancelled" };
  }
}

/** Pure, executor-neutral transition function for one durable task. */
export function applyTaskTransition(view: TaskView, command: TaskCommand): TaskTransitionResult {
  if (command.kind === "bind") {
    const binding = view.executor?.binding;
    if (
      binding !== undefined &&
      binding.kind === command.executor.kind &&
      jsonValuesEqual(binding.data, command.executor.data)
    ) {
      return { action: "noop", view };
    }
    if (binding !== undefined) {
      return {
        action: "rejected",
        reason: `Task "${view.taskId}" already has an executor binding.`,
        view,
      };
    }
    return {
      action: "accepted",
      view: { ...view, executor: { ...view.executor, binding: command.executor } },
    };
  }

  if (command.kind === "set-state") {
    if (isTerminalTaskStatus(view.status)) {
      return {
        action: "rejected",
        reason: `Task "${view.taskId}" is already ${view.status}; "set-state" cannot change a terminal task.`,
        view,
      };
    }
    if (jsonValuesEqual(view.state, command.state)) return { action: "noop", view };
    return { action: "accepted", view: { ...view, state: command.state } };
  }

  if (isTerminalTaskStatus(view.status)) {
    if (command.kind === "cancel" && view.status === "cancelled") {
      return { action: "noop", view };
    }
    return {
      action: "rejected",
      reason: `Task "${view.taskId}" is already ${view.status}; "${command.kind}" cannot change a terminal task.`,
      view,
    };
  }

  switch (command.kind) {
    case "complete":
      return {
        action: "accepted",
        view: terminalView(view, command, {
          lastOutput: { data: command.data, type: "result" },
          status: "completed",
        }),
      };
    case "fail":
    case "reject-dispatch":
      return {
        action: "accepted",
        view: terminalView(view, command, {
          lastOutput: { data: command.data, type: "error" },
          status: "failed",
        }),
      };
    case "cancel":
      return { action: "accepted", view: terminalView(view, command, { status: "cancelled" }) };
    case "require-input":
      if (!isValidInputRequestBatch(command.inputRequests)) {
        return {
          action: "rejected",
          reason: `Task "${view.taskId}" received an invalid input request batch.`,
          view,
        };
      }
      return {
        action: "accepted",
        view: {
          inputRequests: command.inputRequests,
          executor: view.executor,
          metadata: view.metadata,
          state: view.state,
          status: "input_required",
          taskId: view.taskId,
        },
      };
    case "ready":
      return { action: "accepted", view };
    case "answered": {
      if (view.status !== "input_required") return { action: "noop", view };
      const answered = new Set(command.requestIds);
      const remaining = view.inputRequests.filter((request) => {
        const requestId = readTaskInputRequestId(request);
        return requestId === undefined || !answered.has(requestId);
      });
      if (remaining.length === view.inputRequests.length) return { action: "noop", view };
      if (remaining.length > 0) {
        return {
          action: "accepted",
          view: { ...view, inputRequests: remaining },
        };
      }
      return {
        action: "accepted",
        view: {
          executor: view.executor,
          metadata: view.metadata,
          state: view.state,
          status: "working",
          taskId: view.taskId,
        },
      };
    }
  }
}

function isValidInputRequestBatch(requests: readonly TaskInputRequest[]): boolean {
  if (requests.length === 0) return false;
  const ids = requests.map(readTaskInputRequestId);
  return (
    ids.every((id): id is string => id !== undefined && id.length > 0) &&
    new Set(ids).size === ids.length
  );
}
