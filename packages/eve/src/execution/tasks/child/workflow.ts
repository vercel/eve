import { createHook } from "#compiled/@workflow/core/index.js";

import type { ActivityObserverConfig } from "#channel/types.js";
import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import {
  appendTaskProgressStep,
  appendTaskViewStep,
  deliverTaskInputResponsesStep,
  wakeTaskAgentRequestParentStep,
  wakeTaskAuthorizationParentStep,
  wakeTaskMessageParentStep,
  wakeTaskParentStep,
  wakeTaskUpdateParentStep,
  wakeWorkflowTaskInputRequestParentStep,
} from "#execution/tasks/child/steps.js";
import {
  createWorkflowBodyRef,
  executeWorkflowBody,
  type WorkflowBodyDefinition,
  type WorkflowBodyResult,
} from "#execution/tools/workflow/body.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type {
  WorkflowToolAuthorizationRequest,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import { createChannelReader, raceChannelReads } from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerInbox } from "#execution/tools/workflow/owner.js";
import {
  workflowToolRunOutcomeToTaskCommand,
  workflowToolRunReportToTaskPayload,
  workflowToolRunRequestToTaskInputRequest,
} from "#execution/tools/workflow/owner-inbox.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import { applyTaskTransition } from "#tasks/transitions.js";
import {
  isReadyTaskStatus,
  isTerminalTaskStatus,
  readTaskInputRequestId,
  type TaskCommand,
  type TaskInboundAnswerInput,
  type TaskInboundMessage,
  type TaskInputRequest,
  type TaskInboundUpdate,
  type TaskRunInboundPayload,
  type TaskView,
} from "#tasks/types.js";

export interface TaskRunWorkflowInput {
  readonly activityObserver?: ActivityObserverConfig;
  readonly initialView: TaskView;
  readonly parentContinuationToken: string;
  readonly taskInboxToken: string;
  readonly workflow?: WorkflowBodyDefinition;
}

/** A workflow-body question routed through the task that owns the workflow tool run. */
interface WorkflowToolRunTaskInputRequestBase {
  readonly kind: "task-input-request";
  readonly replyTo: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export type WorkflowToolRunTaskInputRequest = WorkflowToolRunTaskInputRequestBase &
  (
    | { readonly request: TaskInputRequest; readonly requests?: never }
    | { readonly request?: never; readonly requests: readonly TaskInputRequest[] }
  );

interface PendingWorkflowToolTraffic {
  readonly messages: TaskInboundMessage[];
  readonly ownerRequests: WorkflowToolRunRequestMessage[];
}

/** Owns lifecycle for one background task and consumes its executor traffic. */
export async function taskRunWorkflow(input: TaskRunWorkflowInput): Promise<void> {
  "use workflow";

  const commands = createHook<TaskRunInboundPayload>({ token: input.taskInboxToken });
  const workflowToolRunInbox = openWorkflowToolRunOwnerInbox();
  const readers = [workflowToolRunInbox.reader, createChannelReader("commands", commands)] as const;
  let view = input.initialView;
  let dispatchAcknowledged = false;
  let dispatchRejected = false;
  let pendingInputRequest: WorkflowToolRunTaskInputRequest | undefined;
  let pendingUpdates: TaskInboundUpdate[] = [];
  let updateIndex = 0;
  const seenReports = new Set<string>();
  const pendingTraffic: PendingWorkflowToolTraffic = { messages: [], ownerRequests: [] };
  const answerHooks = new Map<string, AnswerHookRoute>();
  const bodyController = new AbortController();
  let bodyReader:
    | import("#execution/tools/workflow/owner-channels.js").ChannelReader<
        "body",
        WorkflowBodyResult
      >
    | undefined;
  let executorSettled = input.workflow === undefined;
  let pendingBodyResult: WorkflowBodyResult | undefined;

  try {
    await claimHookOwnership(commands);
  } catch (error) {
    if (isHookConflictError(error)) return;
    throw error;
  }

  await appendTaskViewStep({ activityObserver: input.activityObserver, view });
  while (true) {
    // Hook persistence does not mean the owner has consumed every report yet.
    if (pendingBodyResult !== undefined && updateIndex >= pendingBodyResult.reportCount) {
      executorSettled = true;
      await applyPayload({
        command: workflowToolRunOutcomeToTaskCommand({
          from: createWorkflowBodyRef({ ...input.workflow!, execution: "background" }),
          result: pendingBodyResult.outcome,
        }),
        kind: "task-command",
      });
      pendingBodyResult = undefined;
      if (view.status === "cancelled" && dispatchAcknowledged && !dispatchRejected) {
        await wakeTaskParentStep({ token: input.parentContinuationToken, view });
      }
    }
    if (isFinished()) break;
    const read = await raceChannelReads(
      bodyReader === undefined ? readers : [...readers, bodyReader],
    );
    if (read.channel === "body") {
      bodyReader = undefined;
      if (read.next.done) continue;
      pendingBodyResult = read.next.value;
      continue;
    }
    if (read.next.done) return;

    if (read.channel === "workflow") {
      const message = read.next.value;
      if (message.kind === "report") {
        // Hook resumption can be redelivered after a step retry.
        const identity = JSON.stringify([
          message.from.runId,
          message.from.callId,
          message.reportId,
        ]);
        if (seenReports.has(identity)) continue;
        seenReports.add(identity);
        await applyPayload(workflowToolRunReportToTaskPayload(message, view.taskId, updateIndex++));
        continue;
      }
      if (message.kind === "outcome") {
        await applyPayload({
          command: workflowToolRunOutcomeToTaskCommand(message),
          kind: "task-command",
        });
        continue;
      }
      const request = message;
      const kind = request.request.kind;
      if (kind === "agent-invoke" || kind === "agent-settled" || kind === "authorization-request") {
        await handleOwnerRequest(request);
        continue;
      }
      if (request.requestCoordinates === undefined) {
        answerHooks.set(request.replyTo, { runId: request.from.runId });
      }
      await applyPayload(workflowToolRunRequestToTaskInputRequest(request));
      continue;
    }

    await applyPayload(read.next.value);
  }

  function isFinished(): boolean {
    return isTerminalTaskStatus(view.status) && dispatchAcknowledged && executorSettled;
  }

  async function handleUpdate(update: TaskInboundUpdate): Promise<void> {
    if (view.metadata.kind === "subagent") {
      if (dispatchRejected) return;
      if (dispatchAcknowledged && !isTerminalTaskStatus(view.status)) {
        await wakeTaskUpdateParentStep({ token: input.parentContinuationToken, update, view });
      } else {
        pendingUpdates.push(update);
      }
      return;
    }
    await appendTaskProgressStep({
      progress: {
        callId: update.callId,
        kind: "task-progress",
        taskId: view.taskId,
        update: update.message,
        updateIndex: update.updateIndex,
      },
    });
  }

  async function handleMessage(message: TaskInboundMessage): Promise<void> {
    if (dispatchRejected || isTerminalTaskStatus(view.status)) return;
    if (!dispatchAcknowledged) {
      pendingTraffic.messages.push(message);
      return;
    }
    await wakeTaskMessageParentStep({
      message,
      taskId: view.taskId,
      token: input.parentContinuationToken,
    });
  }

  async function applyPayload(
    payload: TaskRunInboundPayload | WorkflowToolRunTaskInputRequest,
  ): Promise<void> {
    const isReady = payload.kind === "task-command" && payload.command.kind === "ready";
    const isRejected =
      payload.kind === "task-command" && payload.command.kind === "reject-dispatch";
    if (isReady || isRejected) dispatchAcknowledged = true;
    if (isRejected) dispatchRejected = true;
    if (isReady || isRejected) {
      if (isRejected || isTerminalTaskStatus(view.status)) {
        executorSettled = true;
      } else if (
        input.workflow !== undefined &&
        bodyReader === undefined &&
        pendingBodyResult === undefined &&
        !executorSettled
      ) {
        bodyReader = createChannelReader(
          "body",
          awaitBodyResult(
            executeWorkflowBody(
              {
                ...input.workflow,
                execution: "background",
                owner: workflowToolRunInbox.owner,
              },
              bodyController.signal,
            ),
          ),
        );
      }
      await flushPendingTraffic();
    }

    if (payload.kind === "task-input-request") pendingInputRequest = payload;
    if (payload.kind === "task-message") {
      await handleMessage(payload);
      return;
    }
    if (payload.kind === "task-update") {
      await handleUpdate(payload);
      return;
    }

    let command: TaskCommand | undefined;
    if (payload.kind === "input-response") {
      command =
        view.status === "input_required"
          ? await resolveAnsweredCommand(
              view,
              payload,
              answerHooks.get(payload.childContinuationToken),
            )
          : undefined;
    } else if (payload.kind === "task-input-request") {
      command = {
        inputRequests: payload.requests ?? [payload.request],
        kind: "require-input",
      };
    } else if (payload.kind === "task-command") {
      command = payload.command;
    } else {
      return;
    }
    if (command === undefined) return;
    if (isReady && isTerminalTaskStatus(view.status)) {
      await flushUpdates(true);
      await wakeTaskParentStep({ token: input.parentContinuationToken, view });
      return;
    }

    const previous = view;
    const accepted = await transitionTask(command);
    if (!accepted) return;
    if (command.kind === "cancel") {
      bodyController.abort(new Error(`Task ${view.taskId} was cancelled.`));
      if (bodyReader === undefined) executorSettled = true;
    }
    if (!isTerminalTaskStatus(view.status)) await flushUpdates();
    if (
      pendingInputRequest !== undefined &&
      dispatchAcknowledged &&
      view.status === "input_required"
    ) {
      await wakeWorkflowTaskInputRequestParentStep({
        request: pendingInputRequest,
        taskId: view.taskId,
        token: input.parentContinuationToken,
      });
      pendingInputRequest = undefined;
    } else if (
      !dispatchRejected &&
      dispatchAcknowledged &&
      (command.kind !== "cancel" || executorSettled) &&
      ((!isTerminalTaskStatus(previous.status) && isTerminalTaskStatus(view.status)) ||
        (!isReadyTaskStatus(previous.status) &&
          isReadyTaskStatus(view.status) &&
          pendingInputRequest === undefined))
    ) {
      await wakeTaskParentStep({ token: input.parentContinuationToken, view });
    }
    if (view.status !== "input_required") pendingInputRequest = undefined;
  }

  async function flushUpdates(includeTerminal = false): Promise<void> {
    if (!dispatchAcknowledged || (isTerminalTaskStatus(view.status) && !includeTerminal)) return;
    for (const update of pendingUpdates) {
      await wakeTaskUpdateParentStep({ token: input.parentContinuationToken, update, view });
    }
    pendingUpdates = [];
  }

  async function transitionTask(command: TaskCommand): Promise<boolean> {
    const result = applyTaskTransition(view, command);
    if (result.action !== "accepted") return false;
    view = result.view;
    await appendTaskViewStep({ activityObserver: input.activityObserver, view });
    return true;
  }

  // Owner traffic must wait until the parent has acknowledged task dispatch.
  async function handleOwnerRequest(message: WorkflowToolRunRequestMessage): Promise<void> {
    if (!dispatchAcknowledged) {
      pendingTraffic.ownerRequests.push(message);
      return;
    }
    const { request, replyTo } = message;
    if (
      request.kind === "authorization-request" &&
      request.event.childSessionId === message.from.runId
    ) {
      await handleStepAuthorization(request, replyTo);
      return;
    }
    if (dispatchRejected || isTerminalTaskStatus(view.status)) {
      return;
    }
    if (request.kind === "authorization-request") {
      await wakeTaskAuthorizationParentStep({
        request,
        taskId: view.taskId,
        token: input.parentContinuationToken,
      });
      return;
    }
    await wakeTaskAgentRequestParentStep({
      request: message,
      taskId: view.taskId,
      token: input.parentContinuationToken,
    });
  }

  async function handleStepAuthorization(
    request: WorkflowToolAuthorizationRequest,
    replyTo: string,
  ): Promise<void> {
    const event = request.event.event;
    const closesDisplayedPrompt = event.type === "authorization.completed";
    const canForward =
      !dispatchRejected && (!isTerminalTaskStatus(view.status) || closesDisplayedPrompt);

    if (canForward) {
      const requestId = "attemptId" in event.data ? event.data.attemptId : undefined;
      if (requestId !== undefined && event.type === "authorization.required") {
        const existingRequests = view.status === "input_required" ? view.inputRequests : [];
        await transitionTask({
          kind: "require-input",
          inputRequests: [
            ...existingRequests,
            { kind: "authorization", requestId, name: event.data.name },
          ],
        });
      } else if (requestId !== undefined) {
        await transitionTask({ kind: "answered", requestIds: [requestId] });
      }

      await wakeTaskAuthorizationParentStep({
        request,
        taskId: view.taskId,
        token: input.parentContinuationToken,
      });
    }

    // Discarded events are acknowledged too; persistence and delivery failures are not.
    await resumeHookStep(replyTo, null, { ifPresent: true });
  }

  async function flushPendingTraffic(): Promise<void> {
    if (!dispatchRejected) {
      for (const message of pendingTraffic.messages) {
        await wakeTaskMessageParentStep({
          message,
          taskId: view.taskId,
          token: input.parentContinuationToken,
        });
      }
    }
    for (const request of pendingTraffic.ownerRequests) {
      await handleOwnerRequest(request);
    }
    pendingTraffic.messages.length = 0;
    pendingTraffic.ownerRequests.length = 0;
  }
}

async function* awaitBodyResult(
  result: Promise<WorkflowBodyResult>,
): AsyncGenerator<WorkflowBodyResult> {
  yield await result;
}

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
    .filter((id) => outstanding.has(id));
  if (requestIds.length === 0) return undefined;
  return (await deliverTaskInputResponsesStep({ answer, answerHook, requestIds })) === "delivered"
    ? { kind: "answered", requestIds }
    : undefined;
}
