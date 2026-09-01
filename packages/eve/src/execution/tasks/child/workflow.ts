import { createHook } from "#compiled/@workflow/core/index.js";

import { sendAgentHandleCommandStep } from "#execution/session-command-inbox.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  appendTaskViewStep,
  deliverTaskInputResponsesStep,
  wakeTaskAgentEventParentStep,
  wakeTaskParentStep,
  wakeTaskUpdateParentStep,
  wakeWorkflowTaskInputRequestParentStep,
} from "#execution/tasks/child/steps.js";
import { dispatchTaskAgentInvocationStep } from "#execution/tools/subagent/invocation-step.js";
import {
  isAgentInvocationEventEffect,
  isAgentInvocationRequest,
  type AgentInvocationRequest,
} from "#execution/tools/subagent/invocation.js";
import { cancelWorkflowToolRunStep } from "#execution/tools/workflow/cancel.js";
import {
  isWorkflowToolEffectRequest,
  type WorkflowToolEffectRequest,
  type WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import { createChannelReader, raceChannelReads } from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerChannels } from "#execution/tools/workflow/owner.js";
import {
  workflowToolRunOutcomeToTaskCommand,
  workflowToolRunReportToTaskUpdate,
  workflowToolRunRequestToTaskInputRequest,
} from "#execution/tools/workflow/owner-inbox.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import {
  readWorkflowToolExecutorAddress,
  type WorkflowToolAgentDispatch,
} from "#execution/tools/workflow/types.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import { applyTaskTransition } from "#tasks/transitions.js";
import {
  isReadyTaskStatus,
  isTerminalTaskStatus,
  readTaskInputRequestId,
  type TaskCommand,
  type TaskInboundAnswerInput,
  type TaskInputRequest,
  type TaskInboundUpdate,
  type TaskRunInboundPayload,
  type TaskView,
} from "#tasks/types.js";

export interface TaskRunWorkflowInput {
  readonly workflowToolAgentDispatch?: WorkflowToolAgentDispatch;
  readonly initialView: TaskView;
  readonly parentContinuationToken: string;
  readonly taskInboxToken: string;
}

/** A workflow-body question routed through the task that owns the workflow tool run. */
export interface WorkflowToolRunTaskInputRequest {
  readonly kind: "task-input-request";
  readonly replyTo: string;
  readonly request: TaskInputRequest;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

interface PendingWorkflowToolTraffic {
  readonly events: WorkflowToolRunRequestMessage[];
  readonly invocations: WorkflowToolRunRequestMessage[];
}

/** Owns lifecycle for one background task and consumes its executor traffic. */
export async function taskRunWorkflow(input: TaskRunWorkflowInput): Promise<void> {
  "use workflow";

  const commands = createHook<TaskRunInboundPayload>({ token: input.taskInboxToken });
  const workflowToolRunChannels = openWorkflowToolRunOwnerChannels(input.taskInboxToken);
  const readers = [
    ...workflowToolRunChannels.readers,
    createChannelReader("commands", commands),
  ] as const;
  let ownsHook = false;
  let view = input.initialView;
  let dispatchAcknowledged = false;
  let dispatchRejected = false;
  let pendingInputRequest: WorkflowToolRunTaskInputRequest | undefined;
  let pendingUpdates: TaskInboundUpdate[] = [];
  let updateIndex = 0;
  const pendingTraffic: PendingWorkflowToolTraffic = { events: [], invocations: [] };
  const answerHooks = new Map<string, AnswerHookRoute>();
  const dispatchedInvocationIds = new Set<string>();

  try {
    try {
      await claimHookOwnership(commands);
      ownsHook = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    await appendTaskViewStep({ view });
    while (!isFinished()) {
      const read = await raceChannelReads(readers);
      if (read.next.done) return;

      if (read.channel === "report") {
        await applyPayload(
          workflowToolRunReportToTaskUpdate(read.next.value, view.taskId, updateIndex++),
        );
        continue;
      }
      if (read.channel === "outcome") {
        await applyPayload({
          command: workflowToolRunOutcomeToTaskCommand(read.next.value),
          kind: "task-command",
        });
        continue;
      }
      if (read.channel === "request") {
        const request = read.next.value;
        if (isWorkflowToolEffectRequest(request.request)) {
          await handleEffect(request, request.request);
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
  } finally {
    if (ownsHook) {
      try {
        if (isFinished() && input.workflowToolAgentDispatch !== undefined) {
          await sendAgentHandleCommandStep({
            command: { kind: "release-task", taskId: view.taskId },
            commandId: `${view.taskId}:release`,
            sessionId: input.workflowToolAgentDispatch.sessionState.sessionId,
          });
        }
      } finally {
        await workflowToolRunChannels.dispose();
        await disposeHook(commands);
      }
    }
  }

  function isFinished(): boolean {
    return isTerminalTaskStatus(view.status) && dispatchAcknowledged;
  }

  async function handleUpdate(update: TaskInboundUpdate): Promise<void> {
    if (dispatchAcknowledged && !isTerminalTaskStatus(view.status)) {
      await wakeTaskUpdateParentStep({ token: input.parentContinuationToken, update, view });
    } else {
      pendingUpdates.push(update);
    }
  }

  async function applyPayload(
    payload: TaskRunInboundPayload | WorkflowToolRunTaskInputRequest,
  ): Promise<void> {
    const isReady = payload.kind === "task-command" && payload.command.kind === "ready";
    const isRejected =
      payload.kind === "task-command" && payload.command.kind === "reject-dispatch";
    if (isReady || isRejected) dispatchAcknowledged = true;
    if (isRejected) dispatchRejected = true;
    if (isReady || isRejected) await flushPendingTraffic();

    if (payload.kind === "task-input-request") pendingInputRequest = payload;
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
      command = { inputRequests: [payload.request], kind: "require-input" };
    } else if (payload.kind === "task-command") {
      command = payload.command;
    } else {
      return;
    }
    if (command === undefined) return;
    if (isReady && isTerminalTaskStatus(view.status)) {
      await flushUpdates();
      await wakeTaskParentStep({ token: input.parentContinuationToken, view });
      return;
    }

    const previous = view;
    const result = applyTaskTransition(view, command);
    if (result.action !== "accepted") return;
    view = result.view;
    await appendTaskViewStep({ view });
    if (command.kind === "cancel") await cancelWorkflowToolRun();
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
      ((!isTerminalTaskStatus(previous.status) && isTerminalTaskStatus(view.status)) ||
        (!isReadyTaskStatus(previous.status) &&
          isReadyTaskStatus(view.status) &&
          pendingInputRequest === undefined))
    ) {
      await wakeTaskParentStep({ token: input.parentContinuationToken, view });
    }
    if (view.status !== "input_required") pendingInputRequest = undefined;
  }

  async function flushUpdates(): Promise<void> {
    if (!dispatchAcknowledged || isTerminalTaskStatus(view.status)) return;
    for (const update of pendingUpdates) {
      await wakeTaskUpdateParentStep({ token: input.parentContinuationToken, update, view });
    }
    pendingUpdates = [];
  }

  async function handleEffect(
    message: WorkflowToolRunRequestMessage,
    effect: WorkflowToolEffectRequest,
  ): Promise<void> {
    if (isAgentInvocationRequest(effect)) {
      if (input.workflowToolAgentDispatch === undefined) {
        throw new Error("agent.invoke requires a task workflow with agent dispatch context.");
      }
      if (dispatchRejected || isTerminalTaskStatus(view.status)) return;
      if (dispatchedInvocationIds.has(effect.invocationId)) {
        await resumeDuplicateInvocation(message.replyTo, effect);
        return;
      }
      dispatchedInvocationIds.add(effect.invocationId);
      if (!dispatchAcknowledged) {
        pendingTraffic.invocations.push(message);
        return;
      }
      await dispatchAgentInvocation(message);
      return;
    }
    if (isAgentInvocationEventEffect(effect)) {
      if (dispatchRejected || isTerminalTaskStatus(view.status)) return;
      if (!dispatchAcknowledged) {
        pendingTraffic.events.push(message);
        return;
      }
      await wakeTaskAgentEventParent(message);
      return;
    }
    throw new Error(`Unsupported background workflow effect "${effect.name}".`);
  }

  async function flushPendingTraffic(): Promise<void> {
    if (!dispatchRejected) {
      for (const request of pendingTraffic.invocations) await dispatchAgentInvocation(request);
      for (const request of pendingTraffic.events) await wakeTaskAgentEventParent(request);
    }
    pendingTraffic.invocations.length = 0;
    pendingTraffic.events.length = 0;
  }

  async function wakeTaskAgentEventParent(request: WorkflowToolRunRequestMessage): Promise<void> {
    await wakeTaskAgentEventParentStep({
      request,
      taskId: view.taskId,
      token: input.parentContinuationToken,
    });
  }

  async function dispatchAgentInvocation(request: WorkflowToolRunRequestMessage): Promise<void> {
    if (!isAgentInvocationRequest(request.request)) return;
    if (input.workflowToolAgentDispatch === undefined) return;
    const dispatched = await dispatchTaskAgentInvocationStep({
      ...input.workflowToolAgentDispatch,
      replyTo: request.replyTo,
      request: request.request,
      taskId: view.taskId,
    });
    if (dispatched.result !== undefined) {
      await resumeInvocationResult(request.replyTo, dispatched.result);
    }
  }

  async function resumeDuplicateInvocation(
    replyTo: string,
    request: AgentInvocationRequest,
  ): Promise<void> {
    await resumeInvocationResult(replyTo, duplicateInvocationResult(request));
  }

  async function resumeInvocationResult(
    replyTo: string,
    result: RuntimeSubagentResult,
  ): Promise<void> {
    await resumeHookStep(replyTo, {
      kind: "runtime-action-result",
      results: [result],
    });
  }

  async function cancelWorkflowToolRun(): Promise<void> {
    const run = readWorkflowToolExecutorAddress(view.executor?.binding);
    if (run === undefined) return;
    await cancelWorkflowToolRunStep({ reason: `Task ${view.taskId} was cancelled.`, run });
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

function duplicateInvocationResult(request: AgentInvocationRequest): RuntimeSubagentResult {
  return {
    callId: request.invocationId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: "DUPLICATE_AGENT_INVOCATION_KEY",
      message: `agent() invocation key "${invocationKey(request.invocationId)}" was already used in this run; keys must be unique per run.`,
    },
    subagentName: request.input.target,
  };
}

function invocationKey(invocationId: string): string {
  const separator = invocationId.lastIndexOf(":");
  return separator < 0 ? invocationId : invocationId.slice(separator + 1);
}
