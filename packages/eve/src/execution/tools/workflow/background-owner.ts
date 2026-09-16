import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import {
  appendTaskProgressStep,
  appendTaskViewStep,
  deliverTaskInputResponsesStep,
  wakeTaskAgentRequestParentStep,
  wakeTaskAuthorizationParentStep,
  wakeTaskParentStep,
  wakeTaskUpdateParentStep,
  wakeWorkflowTaskInputRequestParentStep,
} from "#execution/tasks/child/steps.js";
import type { BackgroundWorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { createWorkflowToolInvocationReader } from "#execution/tools/workflow/invocation.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type {
  WorkflowToolAuthorizationRequest,
  WorkflowToolRunRequestMessage,
  WorkflowToolRunReport,
  WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import { createChannelReader, raceChannelReads } from "#execution/tools/workflow/owner-channels.js";
import { workflowToolRunInputRequests } from "#execution/tools/workflow/owner-inbox.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import { applyTaskTransition } from "#tasks/transitions.js";
import {
  isTerminalTaskStatus,
  readTaskInputRequestId,
  type TaskCommand,
  type TaskInboundAnswerInput,
  type TaskRunInboundPayload,
  type TaskView,
} from "#tasks/types.js";

/** Admits a session-owned invocation and projects its messages into session state and delivery. */
export async function runBackgroundWorkflowTool(
  input: BackgroundWorkflowToolRunInput,
): Promise<void> {
  const commands = createHook<TaskRunInboundPayload>({ token: input.taskInboxToken });
  const commandReader = createChannelReader("commands", commands);
  let view = input.initialView;
  let dispatchAcknowledged = false;
  let dispatchRejected = false;
  let updateIndex = 0;
  const answerHooks = new Map<string, AnswerHookRoute>();
  const bodyController = new AbortController();
  let invocationReader: ReturnType<typeof createWorkflowToolInvocationReader> | undefined;
  let invocationSettled = false;

  try {
    await claimHookOwnership(commands);
  } catch (error) {
    if (isHookConflictError(error)) return;
    throw error;
  }

  await appendTaskViewStep({ activityObserver: input.activityObserver, view });
  while (true) {
    if (isFinished()) break;
    const read = await raceChannelReads(
      invocationReader === undefined ? [commandReader] : [commandReader, invocationReader],
    );
    if (read.next.done) return;

    if (read.channel === "workflow") {
      const message = read.next.value;
      if (message.kind === "report") {
        await handleReport(message);
        continue;
      }
      if (message.kind === "outcome") {
        invocationSettled = true;
        const transitioned = await transitionTask(message);
        if (
          (transitioned || view.status === "cancelled") &&
          dispatchAcknowledged &&
          !dispatchRejected
        ) {
          await wakeTaskParentStep({ token: input.parentContinuationToken, view });
        }
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
      if (
        await transitionTask({
          kind: "require-input",
          inputRequests: workflowToolRunInputRequests(request),
        })
      ) {
        await wakeWorkflowTaskInputRequestParentStep({
          request,
          taskId: view.taskId,
          token: input.parentContinuationToken,
        });
      }
      continue;
    }

    await applyPayload(read.next.value);
  }

  function isFinished(): boolean {
    return isTerminalTaskStatus(view.status) && dispatchAcknowledged && invocationSettled;
  }

  async function handleReport(report: WorkflowToolRunReport): Promise<void> {
    const index = updateIndex++;
    if (dispatchRejected || isTerminalTaskStatus(view.status)) return;
    if (view.metadata.kind === "subagent") {
      await wakeTaskUpdateParentStep({
        token: input.parentContinuationToken,
        report,
        updateIndex: index,
        view,
      });
      return;
    }
    await appendTaskProgressStep({
      progress: {
        callId: report.from.callId,
        kind: "task-progress",
        taskId: view.taskId,
        update: typeof report.update === "string" ? report.update : JSON.stringify(report.update),
        updateIndex: index,
      },
    });
  }

  async function applyPayload(payload: TaskRunInboundPayload): Promise<void> {
    const isReady = payload.kind === "task-command" && payload.command.kind === "ready";
    const isRejected =
      payload.kind === "task-command" && payload.command.kind === "reject-dispatch";
    if (isReady || isRejected) dispatchAcknowledged = true;
    if (isRejected) dispatchRejected = true;
    if (isReady || isRejected) {
      if (isRejected || isTerminalTaskStatus(view.status)) {
        invocationSettled = true;
      } else if (invocationReader === undefined && !invocationSettled) {
        invocationReader = createWorkflowToolInvocationReader(
          { ...input.workflow, execution: "background" },
          bodyController.signal,
        );
      }
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
    } else if (payload.kind === "task-command") {
      command = payload.command;
    } else {
      return;
    }
    if (command === undefined) return;
    if (isReady && isTerminalTaskStatus(view.status)) {
      await wakeTaskParentStep({ token: input.parentContinuationToken, view });
      return;
    }

    const previous = view;
    const accepted = await transitionTask(command);
    if (!accepted) return;
    if (command.kind === "cancel") {
      bodyController.abort(new Error(`Task ${view.taskId} was cancelled.`));
      if (invocationReader === undefined) invocationSettled = true;
    }
    if (
      !dispatchRejected &&
      dispatchAcknowledged &&
      (command.kind !== "cancel" || invocationSettled) &&
      !isTerminalTaskStatus(previous.status) &&
      isTerminalTaskStatus(view.status)
    ) {
      await wakeTaskParentStep({ token: input.parentContinuationToken, view });
    }
  }

  async function transitionTask(
    command: TaskCommand | Extract<WorkflowToolRunMessage, { kind: "outcome" }>,
  ): Promise<boolean> {
    const result = applyTaskTransition(view, command);
    if (result.action !== "accepted") return false;
    view = result.view;
    await appendTaskViewStep({ activityObserver: input.activityObserver, view });
    return true;
  }

  // Owner traffic must wait until the parent has acknowledged task dispatch.
  async function handleOwnerRequest(message: WorkflowToolRunRequestMessage): Promise<void> {
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
