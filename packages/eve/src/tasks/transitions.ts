import type {
  TaskCommand,
  TaskInputRequest,
  TaskOutput,
  TaskUsage,
  TaskView,
} from "#tasks/types.js";
import { isTerminalTaskStatus, readTaskInputRequestId } from "#tasks/types.js";
import { jsonValuesEqual } from "#shared/json.js";

/**
 * Action taken on one command applied to a task view.
 *
 * - `accepted`: the view changed; the new view must be appended.
 * - `noop`: the command is recognized and benign (idempotent cancel,
 *   stale answer); nothing changed and nothing is appended.
 * - `rejected`: the command is invalid for the current status; the
 *   reason is diagnostic only.
 */
type TaskTransitionResult =
  | { readonly action: "accepted"; readonly view: TaskView }
  | { readonly action: "noop"; readonly view: TaskView }
  | { readonly action: "rejected"; readonly view: TaskView; readonly reason: string };

/**
 * Builds the settled view for one terminal command, carrying the
 * child's lifecycle verdict and reported usage when present. Usage is
 * retention-only: nothing folds it into parent budgets yet.
 */
function terminalView(
  view: TaskView,
  command: Extract<TaskCommand, { kind: "complete" | "fail" | "reject-dispatch" | "cancel" }>,
  settled:
    | {
        readonly lastOutput: Extract<TaskOutput, { type: "result" }>;
        readonly status: "completed";
      }
    | { readonly lastOutput: Extract<TaskOutput, { type: "error" }>; readonly status: "failed" }
    | { readonly status: "cancelled" },
): TaskView {
  const base: Pick<TaskView, "executor" | "metadata" | "taskId"> & { usage?: TaskUsage } = {
    executor:
      command.lifecycle === undefined
        ? view.executor
        : { ...view.executor, lifecycle: command.lifecycle },
    metadata: view.metadata,
    taskId: view.taskId,
  };
  if (command.usage !== undefined) base.usage = command.usage;
  switch (settled.status) {
    case "completed":
      return { ...base, lastOutput: settled.lastOutput, status: "completed" };
    case "failed":
      return { ...base, lastOutput: settled.lastOutput, status: "failed" };
    case "cancelled":
      return { ...base, status: "cancelled" };
  }
}

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
 *
 * Orthogonal to the status, the view carries private executor state
 * (`TaskExecutorState`) with its own lifecycle. These commands move
 * executor fields, never the status above:
 *
 * ```text
 * binding:  unset --bind-------> bound            (replay noop, conflict rejected)
 * address:  unset --start-turn-> session pinned   (turn id updated per delivery)
 * verdict:  unset --complete/fail/cancel/settle-executor-> parked | terminal
 * ```
 *
 * - `bind` writes the executor binding exactly once: replaying the
 *   same binding is a noop, a different one is rejected.
 * - `start-turn` records the child session/turn ids used to address
 *   the executor, rejecting a child-session mismatch.
 * - Terminal commands and a late `settle-executor` record the child's
 *   lifecycle verdict: `parked` means the child session survived and
 *   can take another delivery, `terminal` means it ended with the turn.
 */
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

  if (isTerminalTaskStatus(view.status)) {
    if (command.kind === "settle-executor") {
      const executor = { ...view.executor, lifecycle: "terminal" as const };
      if (sameUsage(view.usage, command.usage) && view.executor?.lifecycle === "terminal") {
        return { action: "noop", view };
      }
      const next = { ...view, executor };
      return {
        action: "accepted",
        view: command.usage === undefined ? next : { ...next, usage: command.usage },
      };
    }
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
      return {
        action: "accepted",
        view: terminalView(view, command, { status: "cancelled" }),
      };
    case "settle-executor":
      return {
        action: "rejected",
        reason: `Task "${view.taskId}" is not terminal; usage settles with its terminal command.`,
        view,
      };
    case "require-authorization": {
      const blocker = { blockedOn: "authorization", requestId: command.requestId };
      if (view.status === "input_required") {
        if (
          view.inputRequests.some(
            (request) => readTaskInputRequestId(request) === command.requestId,
          )
        ) {
          return { action: "noop", view };
        }
        return {
          action: "accepted",
          view: { ...view, inputRequests: [...view.inputRequests, blocker] },
        };
      }
      return {
        action: "accepted",
        view: {
          inputRequests: [blocker],
          executor: view.executor,
          metadata: view.metadata,
          status: "input_required",
          taskId: view.taskId,
        },
      };
    }
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
          status: "input_required",
          taskId: view.taskId,
        },
      };
    case "ready":
      // The readiness command is also the barrier that releases a fast,
      // pre-acknowledgement HITL batch, so the workflow must observe it.
      return { action: "accepted", view };
    case "answered": {
      if (view.status !== "input_required") {
        return { action: "noop", view };
      }

      const answered = new Set(command.requestIds);
      const outstanding = view.inputRequests;
      const remaining = outstanding.filter((request) => {
        const requestId = readTaskInputRequestId(request);
        return requestId === undefined || !answered.has(requestId);
      });
      // An answer that matches nothing outstanding is stale: the batch
      // it was written against was already cleared or replaced. Leaving
      // the current batch intact is what stops it from unblocking a
      // question the human never saw.
      if (remaining.length === outstanding.length) {
        return { action: "noop", view };
      }
      if (remaining.length > 0) {
        return {
          action: "accepted",
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
        action: "accepted",
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
          action: "rejected",
          reason: `Task turn identity "${command.taskId}" does not match "${view.taskId}".`,
          view,
        };
      }
      if (
        view.executor?.childSessionId !== undefined &&
        view.executor.childSessionId !== command.childSessionId
      ) {
        return {
          action: "rejected",
          reason: `Task child session "${command.childSessionId}" does not match "${view.executor.childSessionId}".`,
          view,
        };
      }
      if (
        view.executor?.childSessionId === command.childSessionId &&
        view.executor.childTurnId === command.childTurnId
      ) {
        return { action: "noop", view };
      }
      return {
        action: "accepted",
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

function isValidInputRequestBatch(requests: readonly TaskInputRequest[]): boolean {
  if (requests.length === 0) return false;
  const ids = requests.map(readTaskInputRequestId);
  return (
    ids.every((id): id is string => id !== undefined && id.length > 0) &&
    new Set(ids).size === ids.length
  );
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
