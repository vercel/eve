import { createHook } from "#compiled/@workflow/core/index.js";

import type { ActivityObserverConfig } from "#channel/types.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
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
} from "#execution/tools/workflow/body.js";
import {
  deriveWorkflowToolRunOwner,
  type WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import { createChannelReader, raceChannelReads } from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunOwnerChannels } from "#execution/tools/workflow/owner.js";
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
  const pendingTraffic: PendingWorkflowToolTraffic = { messages: [], ownerRequests: [] };
  const answerHooks = new Map<string, AnswerHookRoute>();
  const bodyController = new AbortController();
  let bodyReader:
    | import("#execution/tools/workflow/owner-channels.js").ChannelReader<
        "body",
        import("#execution/tools/workflow/messages.js").WorkflowToolRunOutcome
      >
    | undefined;
  let executorSettled = input.workflow === undefined;

  try {
    try {
      await claimHookOwnership(commands);
      ownsHook = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    await appendTaskViewStep({ activityObserver: input.activityObserver, view });
    while (!isFinished()) {
      const read = await raceChannelReads(
        bodyReader === undefined ? readers : [...readers, bodyReader],
      );
      if (read.channel === "body") {
        executorSettled = true;
        bodyReader = undefined;
        if (read.next.done) continue;
        await applyPayload({
          command: workflowToolRunOutcomeToTaskCommand({
            from: createWorkflowBodyRef({ ...input.workflow!, execution: "background" }),
            result: read.next.value,
          }),
          kind: "task-command",
        });
        if (view.status === "cancelled" && dispatchAcknowledged && !dispatchRejected) {
          await wakeTaskParentStep({ token: input.parentContinuationToken, view });
        }
        continue;
      }
      if (read.next.done) return;

      if (read.channel === "report") {
        const payload = workflowToolRunReportToTaskPayload(
          read.next.value,
          view.taskId,
          updateIndex++,
        );
        if (payload.kind === "task-message") {
          await handleMessage(payload);
        } else {
          await applyPayload(payload);
        }
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
        const kind = request.request.kind;
        if (
          kind === "agent-invoke" ||
          kind === "agent-settled" ||
          kind === "authorization-request"
        ) {
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
  } finally {
    if (ownsHook) {
      await workflowToolRunChannels.dispose();
      await disposeHook(commands);
    }
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
      } else if (input.workflow !== undefined && bodyReader === undefined && !executorSettled) {
        bodyReader = createChannelReader(
          "body",
          awaitBodyResult(
            executeWorkflowBody(
              {
                ...input.workflow,
                execution: "background",
                owner: deriveWorkflowToolRunOwner(input.taskInboxToken),
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
    const result = applyTaskTransition(view, command);
    if (result.action !== "accepted") return;
    view = result.view;
    await appendTaskViewStep({ activityObserver: input.activityObserver, view });
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

  // Agent requests and authorization events both target the parent session
  // directly and must wait until the parent has acknowledged the task dispatch.
  async function handleOwnerRequest(message: WorkflowToolRunRequestMessage): Promise<void> {
    if (dispatchRejected || isTerminalTaskStatus(view.status)) return;
    if (!dispatchAcknowledged) {
      pendingTraffic.ownerRequests.push(message);
      return;
    }
    await wakeTaskOwnerRequestParent(message);
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
      for (const request of pendingTraffic.ownerRequests) await wakeTaskOwnerRequestParent(request);
    }
    pendingTraffic.messages.length = 0;
    pendingTraffic.ownerRequests.length = 0;
  }

  async function wakeTaskOwnerRequestParent(message: WorkflowToolRunRequestMessage): Promise<void> {
    if (message.request.kind === "authorization-request") {
      await wakeTaskAuthorizationParentStep({
        request: message.request,
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
}

async function* awaitBodyResult(
  result: Promise<import("#execution/tools/workflow/messages.js").WorkflowToolRunOutcome>,
): AsyncGenerator<import("#execution/tools/workflow/messages.js").WorkflowToolRunOutcome> {
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
