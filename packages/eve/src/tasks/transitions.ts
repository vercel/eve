import type { WorkflowToolRunOutcomeMessage } from "#execution/tools/workflow/messages.js";
import { workflowToolRunFailureOutput } from "#execution/tools/workflow/owner-inbox.js";
import {
  isTerminalTaskStatus,
  readTaskInputRequestId,
  type TaskCommand,
  type TaskInputRequest,
  type TaskView,
} from "#tasks/types.js";

export type TaskTransitionResult =
  | { readonly action: "accepted"; readonly view: TaskView }
  | { readonly action: "noop"; readonly view: TaskView }
  | { readonly action: "rejected"; readonly view: TaskView; readonly reason: string };

/** Pure transition function for the background invocation view. */
export function applyTaskTransition(
  view: TaskView,
  command: TaskCommand | ({ readonly kind: "outcome" } & WorkflowToolRunOutcomeMessage),
): TaskTransitionResult {
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

  const base = { metadata: view.metadata, taskId: view.taskId };
  if (command.kind === "outcome") {
    const result = command.result;
    return {
      action: "accepted",
      view:
        result.status === "completed"
          ? { ...base, status: "completed", lastOutput: { type: "result", data: result.output } }
          : result.status === "failed"
            ? {
                ...base,
                status: "failed",
                lastOutput: { type: "error", data: workflowToolRunFailureOutput(command) },
              }
            : { ...base, status: "cancelled" },
    };
  }

  switch (command.kind) {
    case "reject-dispatch":
      return {
        action: "accepted",
        view: { ...base, lastOutput: { data: command.data, type: "error" }, status: "failed" },
      };
    case "cancel":
      return {
        action: "accepted",
        view:
          command.usage === undefined
            ? { ...base, status: "cancelled" }
            : { ...base, status: "cancelled", usage: command.usage },
      };
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
          metadata: view.metadata,
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
          metadata: view.metadata,
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
