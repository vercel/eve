import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  appendTaskSnapshotStep,
  deliverTaskInputResponsesStep,
  wakeTaskAuthorizationParentStep,
  wakeTaskInputRequestParentStep,
  wakeTaskParentStep,
} from "#execution/tasks/run-steps.js";
import { applyTaskTransition } from "#tasks/transitions.js";
import { translateTaskInboundPayload } from "#tasks/wire.js";
import {
  isReadyTaskStatus,
  isTerminalTaskStatus,
  readTaskInputRequestId,
  readTaskUsage,
  type TaskCommand,
  type TaskInboundAnswerInput,
  type TaskInboundAuthorizationEvent,
  type TaskInboundInputRequest,
  type TaskRunInboundPayload,
  type TaskView,
} from "#tasks/types.js";

/** Input for one durable task run. */
export interface TaskRunWorkflowInput {
  /** Private command-hook token; a routing credential, never model-visible. */
  readonly commandToken: string;
  /** The creation snapshot, normally `working`. */
  readonly initialView: TaskView;
  /**
   * Parent session delivery token used to wake a parked parent when the
   * task becomes ready. Absent for runs that should never wake anyone.
   */
  readonly wakeToken?: string;
}

/**
 * The durable task run: single writer for one task's lifecycle.
 *
 * Consumes commands and child wire payloads over its private hook,
 * applies the pure transition function, and appends a full `TaskView`
 * snapshot per accepted command to its `eve.task` run stream. Competing
 * completion, cancellation, and input transitions serialize here;
 * rejected commands (for example a late child result after `cancelled`)
 * change nothing.
 *
 * Wake policy: a transition into a ready status — terminal or
 * `input_required` — delivers a framework notification to the parent
 * session. A parked parent starts a turn; an active turn observes the
 * delivery at its next safe boundary. Nothing else wakes the parent.
 *
 * The run ends when the task reaches a terminal status. Its snapshot
 * stream stays readable, so terminal tasks remain peekable; the
 * disposed hook makes any later command fail loudly instead of queueing
 * against a finished task.
 */
export async function taskRunWorkflow(input: TaskRunWorkflowInput): Promise<void> {
  "use workflow";

  const commands = createHook<TaskRunInboundPayload>({ token: input.commandToken });
  // The iterator shares the hook's durable cursor; create it before
  // claiming so conflict replay is consumed by getConflict(), not a
  // later iterator read.
  const iterator = commands[Symbol.asyncIterator]();
  let ownsHook = false;

  try {
    try {
      await claimHookOwnership(commands);
      ownsHook = true;
    } catch (error) {
      // A duplicate start for the same task (crash between the start
      // side effect and its step commit) loses the claim and exits;
      // the surviving run owns the lifecycle.
      if (isHookConflictError(error)) return;
      throw error;
    }

    let view = input.initialView;
    let pendingInputRequest: TaskInboundInputRequest | undefined;
    let pendingAuthorizationEvent: TaskInboundAuthorizationEvent | undefined;
    let dispatchAcknowledged = false;
    await appendTaskSnapshotStep({ view });

    while (
      !isTerminalTaskStatus(view.status) ||
      !dispatchAcknowledged ||
      (view.status === "cancelled" && view.executor?.lifecycle !== "terminal")
    ) {
      const next = await iterator.next();
      if (next.done === true) return;
      if (next.value.kind === "task-command") dispatchAcknowledged = true;
      if (next.value.kind === "subagent-input-request") {
        pendingInputRequest = next.value;
      }
      if (next.value.kind === "subagent-authorization-event") {
        pendingAuthorizationEvent = next.value;
      }
      const command =
        view.status === "cancelled" && next.value.kind === "runtime-action-result"
          ? {
              kind: "settle-executor" as const,
              usage: readTaskUsage(next.value.results[0]?.outcome?.usageDelta),
            }
          : next.value.kind === "task-answer-input"
            ? await resolveAnsweredCommand(view, next.value)
            : translateTaskInboundPayload(next.value);
      if (command === undefined) continue;
      const result = applyTaskTransition(view, command);
      if (result.outcome !== "accepted") continue;
      const becameTerminal =
        !isTerminalTaskStatus(view.status) && isTerminalTaskStatus(result.view.status);
      const becameReady = !isReadyTaskStatus(view.status) && isReadyTaskStatus(result.view.status);
      view = result.view;
      await appendTaskSnapshotStep({ view });
      if (
        pendingAuthorizationEvent !== undefined &&
        dispatchAcknowledged &&
        input.wakeToken !== undefined
      ) {
        await wakeTaskAuthorizationParentStep({
          request: pendingAuthorizationEvent,
          taskId: view.taskId,
          token: input.wakeToken,
        });
        pendingAuthorizationEvent = undefined;
      }
      const routableInputRequest =
        pendingInputRequest !== undefined &&
        dispatchAcknowledged &&
        view.status === "input_required";
      if (routableInputRequest && input.wakeToken !== undefined) {
        await wakeTaskInputRequestParentStep({
          request: pendingInputRequest as TaskInboundInputRequest,
          taskId: view.taskId,
          token: input.wakeToken,
        });
        pendingInputRequest = undefined;
      } else if (
        (becameTerminal ||
          (becameReady && pendingInputRequest === undefined)) &&
        input.wakeToken !== undefined
      ) {
        await wakeTaskParentStep({ token: input.wakeToken, view });
      }
      // An unrouted request cannot outlive the block it described, or a
      // later block would replay it to the parent as if it were new.
      if (view.status !== "input_required") pendingInputRequest = undefined;
    }
  } finally {
    // Dispose-only teardown: `iterator.return()` would await a pending
    // durable read that never settles, leaving this run `running`
    // forever and its hook unswept.
    if (ownsHook) await disposeHook(commands);
  }
}

/**
 * Forwards one human answer to the blocked child and reports which
 * requests it cleared.
 *
 * Delivery is attempted only for requests the run still lists as
 * outstanding, and the resulting command names exactly those ids. That
 * ordering is the point: answers to a superseded batch never reach the
 * child, and a child whose hook is already gone leaves the task blocked
 * instead of moving to `working` with nothing listening.
 */
async function resolveAnsweredCommand(
  view: TaskView,
  answer: TaskInboundAnswerInput,
): Promise<TaskCommand | undefined> {
  if (answer.taskId !== view.taskId || view.status !== "input_required") return undefined;

  const outstanding = new Set(
    (view.inputRequests ?? []).flatMap((request) => {
      const requestId = readTaskInputRequestId(request);
      return requestId === undefined ? [] : [requestId];
    }),
  );
  const requestIds = answer.inputResponses
    .map((response) => response.requestId)
    .filter((requestId) => outstanding.has(requestId));
  if (requestIds.length === 0) return undefined;

  const delivery = await deliverTaskInputResponsesStep({ answer, requestIds });
  return delivery === "delivered" ? { kind: "answered", requestIds } : undefined;
}
