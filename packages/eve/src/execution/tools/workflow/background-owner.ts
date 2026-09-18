import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import {
  appendTaskProgressStep,
  emitTaskActivityStep,
  deliverTaskInputResponsesStep,
  wakeTaskAgentRequestParentStep,
  wakeTaskAuthorizationParentStep,
  wakeTaskParentStep,
  wakeTaskUpdateParentStep,
  wakeWorkflowTaskInputRequestParentStep,
} from "#execution/tasks/child/steps.js";
import type { BackgroundWorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type {
  WorkflowToolAuthorizationRequest,
  WorkflowToolRunRequestMessage,
  WorkflowToolRunReport,
  WorkflowToolRunMessage,
} from "#execution/tools/workflow/messages.js";
import {
  createChannelReader,
  type ChannelReader,
} from "#execution/tools/workflow/owner-channels.js";
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

export interface BackgroundWorkflowOwner {
  readonly kind: "session";
  readonly commands: ChannelReader<"commands", TaskRunInboundPayload>;
  readonly signal: AbortSignal;
  handleCommand(payload: TaskRunInboundPayload): Promise<"start" | "stop" | undefined>;
  handleMessage(message: WorkflowToolRunMessage): Promise<void>;
}

/** Routes child messages; the parent session owns persisted task state. */
export async function createBackgroundWorkflowOwner(
  input: BackgroundWorkflowToolRunInput,
): Promise<BackgroundWorkflowOwner | undefined> {
  const commands = createHook<TaskRunInboundPayload>({ token: input.taskInboxToken });
  let view = input.initialView;
  let updateIndex = 0;
  const answerHooks = new Map<string, AnswerHookRoute>();
  const bodyController = new AbortController();
  try {
    await claimHookOwnership(commands);
  } catch (error) {
    if (isHookConflictError(error)) return;
    throw error;
  }
  await emitTaskActivityStep({ activityObserver: input.activityObserver, view });
  return {
    kind: "session",
    commands: createChannelReader("commands", commands),
    signal: bodyController.signal,
    handleCommand,
    handleMessage,
  };

  async function handleCommand(
    payload: TaskRunInboundPayload,
  ): Promise<"start" | "stop" | undefined> {
    if (payload.kind === "task-command") {
      if (payload.command.kind === "ready") {
        if (!isTerminalTaskStatus(view.status)) return "start";
        await wakeTaskParentStep({ token: input.parentContinuationToken, view });
        return "stop";
      }
      if (payload.command.kind === "reject-dispatch") {
        applyTransition(payload.command);
        return "stop";
      }
    }
    await applyPayload(payload);
  }

  async function handleMessage(message: WorkflowToolRunMessage): Promise<void> {
    if (message.kind === "report") {
      await handleReport(message);
      return;
    }
    if (message.kind === "outcome") {
      const transitioned = applyTransition(message);
      if (transitioned || view.status === "cancelled") {
        await wakeTaskParentStep({ token: input.parentContinuationToken, view });
      }
      return;
    }
    const request = message;
    const kind = request.request.kind;
    if (kind === "agent-invoke" || kind === "agent-settled" || kind === "authorization-request") {
      await handleOwnerRequest(request);
      return;
    }
    if (request.requestCoordinates === undefined) {
      answerHooks.set(request.replyTo, { runId: request.from.runId });
    }
    const accepted = applyTransition({
      kind: "require-input",
      inputRequests: workflowToolRunInputRequests(request),
    });
    if (!accepted) return;
    await wakeWorkflowTaskInputRequestParentStep({
      request,
      taskId: view.taskId,
      token: input.parentContinuationToken,
    });
  }

  async function handleReport(report: WorkflowToolRunReport): Promise<void> {
    const index = updateIndex++;
    if (isTerminalTaskStatus(view.status)) return;
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

    const accepted = applyTransition(command);
    if (!accepted) return;
    if (command.kind === "cancel") {
      bodyController.abort(new Error(`Task ${view.taskId} was cancelled.`));
    }
  }

  function applyTransition(
    command: TaskCommand | Extract<WorkflowToolRunMessage, { kind: "outcome" }>,
  ): boolean {
    const result = applyTaskTransition(view, command);
    if (result.action !== "accepted") return false;
    view = result.view;
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
    if (isTerminalTaskStatus(view.status)) {
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
    const canForward = !isTerminalTaskStatus(view.status) || closesDisplayedPrompt;

    if (canForward) {
      const requestId = "attemptId" in event.data ? event.data.attemptId : undefined;
      if (requestId !== undefined && event.type === "authorization.required") {
        const existingRequests = view.status === "input_required" ? view.inputRequests : [];
        applyTransition({
          kind: "require-input",
          inputRequests: [
            ...existingRequests,
            { kind: "authorization", requestId, name: event.data.name },
          ],
        });
      } else if (requestId !== undefined) {
        applyTransition({ kind: "answered", requestIds: [requestId] });
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
