import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, isHookConflictError } from "#execution/hook-ownership.js";
import {
  emitTaskActivityStep,
  deliverTaskInputResponsesStep,
  notifyTaskParent,
} from "#execution/tasks/child/notify.js";
import type { BackgroundWorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { deliverWorkflowAuthorization } from "#execution/tools/workflow/owner.js";
import type {
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
        await notifyTaskParent({ token: input.parentContinuationToken, view });
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
        await notifyTaskParent({ token: input.parentContinuationToken, view });
      }
      return;
    }
    const request = message;
    const kind = request.request.kind;
    if (
      kind === "sandbox-request" ||
      kind === "agent-invoke" ||
      kind === "agent-settled" ||
      kind === "authorization-request"
    ) {
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
    await notifyTaskParent({
      request,
      taskId: view.taskId,
      token: input.parentContinuationToken,
    });
  }

  async function handleReport(report: WorkflowToolRunReport): Promise<void> {
    const index = updateIndex++;
    if (view.metadata.kind !== "subagent" || isTerminalTaskStatus(view.status)) return;
    await notifyTaskParent({
      token: input.parentContinuationToken,
      update: { report, index },
      view,
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
    const { request } = message;
    if (request.kind === "authorization-request") {
      await deliverWorkflowAuthorization({ ...message, request }, async () => {
        // A cancelled workflow may still need to close its own displayed prompt.
        const closesPrompt =
          request.event.childSessionId === message.from.runId &&
          request.event.event.type === "authorization.completed";
        if (isTerminalTaskStatus(view.status) && !closesPrompt) return;
        await notifyTaskParent({
          request: message,
          taskId: view.taskId,
          token: input.parentContinuationToken,
        });
      });
      return;
    }
    if (isTerminalTaskStatus(view.status)) return;
    await notifyTaskParent({
      request: message,
      taskId: view.taskId,
      token: input.parentContinuationToken,
    });
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
