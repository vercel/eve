import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import { createHook } from "#compiled/@workflow/core/index.js";

import type {
  ActivityObserverConfig,
  SubagentAuthorizationEventHookPayload,
} from "#channel/types.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  appendTaskViewStep,
  deliverTaskInputResponsesStep,
  wakeTaskAuthorizationParentStep,
  wakeTaskInputRequestParentStep,
  wakeTaskParentStep,
  wakeTaskUpdateParentStep,
} from "#execution/tasks/child/steps.js";
import { applyTaskTransition } from "#tasks/transitions.js";
import { translateTaskInboundPayload } from "#tasks/wire.js";
import { createChannelReader, raceChannelReads } from "#execution/tool-run/owner-channels.js";
import { openRunOwnerChannels } from "#execution/tool-run/owner.js";
import {
  runOutcomeToTaskCommand,
  runReportToTaskUpdate,
  runRequestToInputRequestPayload,
} from "#execution/tool-run/owner-inbox.js";
import {
  isReadyTaskStatus,
  isTerminalTaskStatus,
  readTaskInputRequestId,
  readTaskUsage,
  type TaskCommand,
  type TaskInboundAnswerInput,
  type TaskInboundAuthorizationEvent,
  type TaskInboundInputRequest,
  type TaskInboundUpdate,
  type TaskRunInboundPayload,
  type TaskView,
} from "#tasks/types.js";

/** Input for one durable task run. */
export interface TaskRunWorkflowInput {
  /** Activity sink and work identity for best-effort terminal settlement. */
  readonly activityObserver?: ActivityObserverConfig;
  /** Private task inbox token; a routing credential, never model-visible. */
  readonly taskInboxToken: string;
  /** The creation view, normally `working`. */
  readonly initialView: TaskView;
  /** Parent session delivery token used to wake the task's owning parent. */
  readonly parentContinuationToken: string;
}

type TaskRunHookPayload = TaskRunInboundPayload | SubagentAuthorizationEventHookPayload;

function isTaskRunFinished(view: TaskView, dispatchAcknowledged: boolean): boolean {
  if (!isTerminalTaskStatus(view.status) || !dispatchAcknowledged) return false;

  // Cancellation makes the task terminal before the child executor has
  // necessarily unwound. Keep its hook open until the final result settles it.
  return view.status !== "cancelled" || view.executor?.lifecycle === "terminal";
}

/**
 * The durable task run: single writer for one task's lifecycle.
 *
 * Consumes commands and child wire payloads over its private hook,
 * applies the pure transition function, and appends a full `TaskView`
 * per accepted command to its `eve.task` run stream. Competing
 * completion, cancellation, and input transitions serialize here;
 * rejected commands (for example a late child result after `cancelled`)
 * change nothing.
 *
 * Wake policy: a transition into a ready status — terminal or
 * `input_required` — and an explicit child `task_update` deliver a
 * framework notification to the parent session. A parked parent starts
 * a turn; an active turn observes the delivery at its next safe boundary.
 *
 * The run ends when the task reaches a terminal status. Its view
 * stream stays readable, so terminal tasks remain peekable; the
 * disposed hook makes any later command fail loudly instead of queueing
 * against a finished task.
 */
export async function taskRunWorkflow(input: TaskRunWorkflowInput): Promise<void> {
  "use workflow";

  const commands = createHook<TaskRunHookPayload>({ token: input.taskInboxToken });
  // The iterator shares the hook's durable cursor; create it before
  // claiming so conflict replay is consumed by getConflict(), not a
  // later iterator read.
  const commandReader = createChannelReader("commands", commands);
  // Before the claim: the parent hands the token to a run as soon as the claim
  // lands, and that run may report at once.
  const runChannels = openRunOwnerChannels(input.taskInboxToken);
  const readers = [...runChannels.readers, commandReader] as const;
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
    let pendingAuthorizationEvents: TaskInboundAuthorizationEvent[] = [];
    let pendingUpdates: TaskInboundUpdate[] = [];
    let dispatchAcknowledged = false;
    let runUpdateIndex = 0;
    // The parent answers with the request's token; only this run knows it was a hook.
    const answerHooks = new Map<string, AnswerHookRoute>();
    await appendTaskViewStep({ activityObserver: input.activityObserver, view });

    while (!isTaskRunFinished(view, dispatchAcknowledged)) {
      const read = await raceChannelReads(readers);
      if (read.next.done === true) return;
      if (read.channel === "request") {
        answerHooks.set(read.next.value.answerToken, { runId: read.next.value.from.runId });
      }
      const raw: TaskRunHookPayload =
        read.channel === "report"
          ? runReportToTaskUpdate(read.next.value, view.taskId, runUpdateIndex++)
          : read.channel === "request"
            ? runRequestToInputRequestPayload(read.next.value)
            : read.channel === "outcome"
              ? { command: runOutcomeToTaskCommand(read.next.value), kind: "task-command" }
              : read.next.value;
      const payload: TaskRunInboundPayload =
        raw.kind === "subagent-authorization-event" ? { ...raw, kind: "authorization-event" } : raw;
      // Approval lifecycle events (`approval.candidate`/`approval.settled`)
      // are intra-child responder bookkeeping, not task blockers: only
      // `authorization.required`/`authorization.completed` may block or
      // unblock a task. Forwarding them would mint bogus `answered`
      // commands and race the terminal wake.
      if (
        payload.kind === "authorization-event" &&
        (payload.event.type === "approval.candidate" || payload.event.type === "approval.settled")
      ) {
        continue;
      }
      const isReadinessCommand =
        payload.kind === "task-command" && payload.command.kind === "ready";
      const isRejectedDispatch =
        payload.kind === "task-command" && payload.command.kind === "reject-dispatch";
      if (isReadinessCommand || isRejectedDispatch) dispatchAcknowledged = true;
      if (payload.kind === "subagent-input-request") {
        pendingInputRequest = payload;
      }
      if (payload.kind === "authorization-event") {
        pendingAuthorizationEvents.push(payload);
      }
      if (payload.kind === "task-update") {
        if (dispatchAcknowledged && !isTerminalTaskStatus(view.status)) {
          await wakeTaskUpdateParentStep({
            token: input.parentContinuationToken,
            update: payload,
            view,
          });
        } else {
          pendingUpdates.push(payload);
        }
        continue;
      }
      const isExecutorResultAfterCancellation =
        view.status === "cancelled" && payload.kind === "runtime-action-result";
      const isTaskInputAnswer = payload.kind === "input-response";
      let command: TaskCommand | undefined;

      if (isExecutorResultAfterCancellation) {
        command = {
          kind: "settle-executor",
          usage: readTaskUsage(payload.results[0]?.outcome?.usageDelta),
        };
      } else if (isTaskInputAnswer) {
        if (view.status !== "input_required") continue;
        command = await resolveAnsweredCommand(
          view,
          payload,
          answerHooks.get(payload.childContinuationToken),
        );
      } else {
        command = translateTaskInboundPayload(payload);
      }
      if (command === undefined) continue;
      if (isReadinessCommand && isTerminalTaskStatus(view.status)) {
        for (const update of pendingUpdates) {
          await wakeTaskUpdateParentStep({
            token: input.parentContinuationToken,
            update,
            view,
          });
        }
        pendingUpdates = [];
        await wakeTaskParentStep({ token: input.parentContinuationToken, view });
        continue;
      }
      const result = applyTaskTransition(view, command);
      if (result.action !== "accepted") continue;
      const becameTerminal =
        !isTerminalTaskStatus(view.status) && isTerminalTaskStatus(result.view.status);
      const becameReady = !isReadyTaskStatus(view.status) && isReadyTaskStatus(result.view.status);
      view = result.view;
      await appendTaskViewStep({ activityObserver: input.activityObserver, view });
      const routableAuthorizationEvents =
        dispatchAcknowledged && !becameTerminal ? pendingAuthorizationEvents : [];
      for (const request of routableAuthorizationEvents) {
        await wakeTaskAuthorizationParentStep({
          request,
          taskId: view.taskId,
          token: input.parentContinuationToken,
        });
      }
      if (dispatchAcknowledged && pendingUpdates.length > 0 && !isTerminalTaskStatus(view.status)) {
        for (const update of pendingUpdates) {
          await wakeTaskUpdateParentStep({
            token: input.parentContinuationToken,
            update,
            view,
          });
        }
        pendingUpdates = [];
      }
      if (becameTerminal || routableAuthorizationEvents.length > 0) pendingAuthorizationEvents = [];
      const routableInputRequest =
        pendingInputRequest !== undefined &&
        dispatchAcknowledged &&
        view.status === "input_required";
      if (routableInputRequest) {
        await wakeTaskInputRequestParentStep({
          request: pendingInputRequest as TaskInboundInputRequest,
          taskId: view.taskId,
          token: input.parentContinuationToken,
        });
        pendingInputRequest = undefined;
      } else if (
        !isRejectedDispatch &&
        routableAuthorizationEvents.length === 0 &&
        dispatchAcknowledged &&
        (becameTerminal || (becameReady && pendingInputRequest === undefined))
      ) {
        await wakeTaskParentStep({ token: input.parentContinuationToken, view });
      }
      // An unrouted request cannot outlive the block it described, or a
      // later block would replay it to the parent as if it were new.
      if (view.status !== "input_required") pendingInputRequest = undefined;
    }
  } finally {
    // Dispose-only teardown: `iterator.return()` would await a pending
    // durable read that never settles, leaving this run `running`
    // forever and its hook unswept.
    if (ownsHook) {
      await runChannels.dispose();
      await disposeHook(commands);
    }
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
  view: Extract<TaskView, { status: "input_required" }>,
  answer: TaskInboundAnswerInput,
  answerHook: AnswerHookRoute | undefined,
): Promise<TaskCommand | undefined> {
  if (answer.taskId !== view.taskId) return undefined;

  const outstanding = new Set(
    view.inputRequests.flatMap((request) => {
      const requestId = readTaskInputRequestId(request);
      return requestId === undefined ? [] : [requestId];
    }),
  );
  const requestIds = answer.inputResponses
    .map((response) => response.requestId)
    .filter((requestId) => outstanding.has(requestId));
  if (requestIds.length === 0) return undefined;

  const delivery = await deliverTaskInputResponsesStep({ answer, answerHook, requestIds });
  return delivery === "delivered" ? { kind: "answered", requestIds } : undefined;
}
