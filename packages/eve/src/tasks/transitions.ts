import type { TaskCommand, TaskOutput, TaskStatus, TaskUsage, TaskView } from "#tasks/types.js";
import { isTerminalTaskStatus, readTaskInputRequestId } from "#tasks/types.js";

/**
 * Outcome of applying one command to a task snapshot.
 *
 * - `accepted`: the state changed; the new view must be appended.
 * - `noop`: the command is recognized and benign (idempotent cancel,
 *   stale answer); nothing changed and nothing is appended.
 * - `rejected`: the command is invalid for the current status; the
 *   reason is diagnostic only.
 */
export type TaskTransitionResult =
  | { readonly outcome: "accepted"; readonly view: TaskView }
  | { readonly outcome: "noop"; readonly view: TaskView }
  | { readonly outcome: "rejected"; readonly view: TaskView; readonly reason: string };

/**
 * Pure transition function for the task lifecycle:
 *
 * ```text
 * working <-> input_required
 *    |             |
 *    +-----> completed
 *    +-----> failed
 *    +-----> cancelled
 * ```
 *
 * Terminal states are final: a late child result can never revive a
 * cancelled task, and repeated cancellation is idempotent. The durable
 * task run is the only caller that persists accepted views, which is
 * what serializes competing completion, cancellation, and input
 * transitions.
 */
/**
 * Builds the settled snapshot for one terminal command, carrying the
 * child's lifecycle verdict and reported usage when present. Usage is
 * retention-only: nothing folds it into parent budgets yet.
 */
function terminalView(
  view: TaskView,
  command: Extract<TaskCommand, { kind: "complete" | "fail" | "cancel" }>,
  settled: { readonly lastOutput?: TaskOutput; readonly status: TaskStatus },
): TaskView {
  const next: {
    executor?: TaskView["executor"];
    lastOutput?: TaskOutput;
    metadata: TaskView["metadata"];
    status: TaskStatus;
    taskId: string;
    usage?: TaskUsage;
  } = {
    executor:
      command.lifecycle === undefined
        ? view.executor
        : { ...view.executor, lifecycle: command.lifecycle },
    metadata: view.metadata,
    status: settled.status,
    taskId: view.taskId,
  };
  if (settled.lastOutput !== undefined) next.lastOutput = settled.lastOutput;
  if (command.usage !== undefined) next.usage = command.usage;
  return next;
}

export function applyTaskTransition(view: TaskView, command: TaskCommand): TaskTransitionResult {
  if (isTerminalTaskStatus(view.status)) {
    if (command.kind === "settle-executor") {
      const executor = { ...view.executor, lifecycle: "terminal" as const };
      if (sameUsage(view.usage, command.usage) && view.executor?.lifecycle === "terminal") {
        return { outcome: "noop", view };
      }
      const next = { ...view, executor };
      return {
        outcome: "accepted",
        view: command.usage === undefined ? next : { ...next, usage: command.usage },
      };
    }
    if (command.kind === "cancel" && view.status === "cancelled") {
      return { outcome: "noop", view };
    }

    return {
      outcome: "rejected",
      reason: `Task "${view.taskId}" is already ${view.status}; "${command.kind}" cannot change a terminal task.`,
      view,
    };
  }

  switch (command.kind) {
    case "complete":
      return {
        outcome: "accepted",
        view: terminalView(view, command, {
          lastOutput: { data: command.data, type: "result" },
          status: "completed",
        }),
      };
    case "fail":
      return {
        outcome: "accepted",
        view: terminalView(view, command, {
          lastOutput: { data: command.data, type: "error" },
          status: "failed",
        }),
      };
    case "cancel":
      return {
        outcome: "accepted",
        view: terminalView(view, command, { status: "cancelled" }),
      };
    case "settle-executor":
      return {
        outcome: "rejected",
        reason: `Task "${view.taskId}" is not terminal; usage settles with its terminal command.`,
        view,
      };
    case "require-input":
      return {
        outcome: "accepted",
        view: {
          inputRequests: command.inputRequests,
          executor: view.executor,
          metadata: view.metadata,
          status: "input_required",
          taskId: view.taskId,
        },
      };
    case "ready":
      // The readiness command is also the barrier that releases a fast,
      // pre-acknowledgement HITL batch, so the workflow must observe it.
      return { outcome: "accepted", view };
    case "answered": {
      if (view.status !== "input_required") {
        return { outcome: "noop", view };
      }

      const answered = new Set(command.requestIds);
      const outstanding = view.inputRequests ?? [];
      const remaining = outstanding.filter((request) => {
        const requestId = readTaskInputRequestId(request);
        return requestId === undefined || !answered.has(requestId);
      });
      // An answer that matches nothing outstanding is stale: the batch
      // it was written against was already cleared or replaced. Leaving
      // the current batch intact is what stops it from unblocking a
      // question the human never saw.
      if (remaining.length === outstanding.length) {
        return { outcome: "noop", view };
      }
      if (remaining.length > 0) {
        return {
          outcome: "accepted",
          view: {
            inputRequests: remaining,
            executor: view.executor,
            metadata: view.metadata,
            status: "input_required",
            taskId: view.taskId,
          },
        };
      }

      return {
        outcome: "accepted",
        view: {
          executor: view.executor,
          metadata: view.metadata,
          status: "working",
          taskId: view.taskId,
        },
      };
    }
    case "start-turn": {
      if (command.taskId !== view.taskId) {
        return {
          outcome: "rejected",
          reason: `Task turn identity "${command.taskId}" does not match "${view.taskId}".`,
          view,
        };
      }
      if (
        view.executor?.childSessionId !== undefined &&
        view.executor.childSessionId !== command.childSessionId
      ) {
        return {
          outcome: "rejected",
          reason: `Task child session "${command.childSessionId}" does not match "${view.executor.childSessionId}".`,
          view,
        };
      }
      if (
        view.executor?.childSessionId === command.childSessionId &&
        view.executor.childTurnId === command.childTurnId
      ) {
        return { outcome: "noop", view };
      }
      return {
        outcome: "accepted",
        view: {
          ...view,
          executor: {
            ...view.executor,
            childSessionId: command.childSessionId,
            childTurnId: command.childTurnId,
          },
        },
      };
    }
  }
}

function sameUsage(left: TaskUsage | undefined, right: TaskUsage | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left?.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens
  );
}
