import { createOwnerInbox } from "#execution/inbox/owner.js";
import { publishOwnerStep } from "#execution/inbox/readiness.js";
import type { InboxEnvelope, ReplyTarget } from "#execution/inbox/types.js";
import type {
  WorkflowToolRunOutcome,
  WorkflowToolRunReport,
  WorkflowToolRunOutcomeMessage,
} from "#execution/workflow-tool/messages.js";
import {
  appendTaskViewStep,
  deliverTaskInputResponsesStep,
  wakeTaskAgentRequestParentStep,
  wakeTaskAuthorizationParentStep,
  wakeTaskParentStep,
  wakeTaskUpdateParentStep,
  wakeWorkflowTaskInputRequestParentStep,
} from "#execution/tasks/steps.js";
import {
  createWorkflowBodyRef,
  executeWorkflowBody,
  type WorkflowBodyDefinition,
} from "#execution/workflow-tool/body.js";
import { type WorkflowToolRunRequestMessage } from "#execution/workflow-tool/messages.js";
import {
  workflowToolRunOutcomeToTaskCommand,
  workflowToolRunReportToTaskUpdate,
  workflowToolRunRequestToTaskInputRequest,
} from "#execution/workflow-tool/results.js";
import type { InboxResponseRoute } from "#harness/proxy-input-requests.js";
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
  readonly initialView: TaskView;
  readonly parentContinuationToken: string;
  readonly taskInboxToken: string;
  readonly workflow?: WorkflowBodyDefinition;
}

/** A workflow-body question routed through the task that owns the workflow tool run. */
interface WorkflowToolRunTaskInputRequestBase {
  readonly kind: "task-input-request";
  readonly replyTo: ReplyTarget;
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
  readonly ownerRequests: WorkflowToolRunRequestMessage[];
}

/** Owns lifecycle for one background task and consumes its executor traffic. */
export async function taskRunWorkflow(input: TaskRunWorkflowInput): Promise<void> {
  "use workflow";

  const inbox = createOwnerInbox({ token: input.taskInboxToken });
  let view = input.initialView;
  let dispatchAcknowledged = false;
  let dispatchRejected = false;
  let pendingInputRequest: WorkflowToolRunTaskInputRequest | undefined;
  let pendingUpdates: TaskInboundUpdate[] = [];
  let updateIndex = 0;
  const pendingTraffic: PendingWorkflowToolTraffic = { ownerRequests: [] };
  const inboxResponses = new Map<string, InboxResponseRoute>();
  const bodyController = new AbortController();
  let body: Promise<WorkflowToolRunOutcome> | undefined;
  let pendingInbox:
    | Promise<
        { kind: "inbox"; envelope: InboxEnvelope } | { kind: "reader-failure"; error: unknown }
      >
    | undefined;
  let executorSettled = input.workflow === undefined;
  const stopObserving = inbox.observe(
    () => {},
    (error) => bodyController.abort(error),
  );

  try {
    const claim = await inbox.claim();
    await publishOwnerStep(
      claim.kind === "owned"
        ? inbox.address
        : { token: input.taskInboxToken, ownerRunId: claim.runId },
    );
    if (claim.kind === "conflict") return;

    await appendTaskViewStep({ view });
    while (!isFinished()) {
      pendingInbox ??= inbox.next().then(
        (envelope) => ({ kind: "inbox" as const, envelope }),
        (error) => ({ kind: "reader-failure" as const, error }),
      );
      const incoming = pendingInbox;
      const read = await (body === undefined
        ? incoming
        : Promise.race([incoming, body.then((outcome) => ({ kind: "body" as const, outcome }))]));
      if (read.kind === "reader-failure") throw read.error;
      if (read.kind === "body") {
        executorSettled = true;
        body = undefined;
        await applyPayload({
          command: workflowToolRunOutcomeToTaskCommand({
            from: createWorkflowBodyRef({ ...input.workflow!, execution: "background" }),
            result: read.outcome,
          }),
          kind: "task-command",
        });
        if (view.status === "cancelled" && dispatchAcknowledged && !dispatchRejected) {
          await wakeTaskParentStep({ token: input.parentContinuationToken, view });
        }
        continue;
      }
      pendingInbox = undefined;
      const envelope = read.envelope;
      if (envelope.kind.startsWith("tool.")) {
        const from = (envelope.payload as { from: { runId: string; callId: string } }).from;
        if (
          from.runId !== inbox.address.ownerRunId ||
          (input.workflow !== undefined && from.callId !== input.workflow.callId)
        )
          continue;
      }
      if (envelope.kind === "tool.report") {
        await applyPayload(
          workflowToolRunReportToTaskUpdate(
            envelope.payload as WorkflowToolRunReport,
            view.taskId,
            updateIndex++,
          ),
        );
      } else if (envelope.kind === "tool.outcome") {
        await applyPayload({
          command: workflowToolRunOutcomeToTaskCommand(
            envelope.payload as WorkflowToolRunOutcomeMessage,
          ),
          kind: "task-command",
        });
      } else if (envelope.kind === "tool.request") {
        const request = envelope.payload as WorkflowToolRunRequestMessage;
        const kind = request.request.kind;
        if (
          kind === "agent-invoke" ||
          kind === "agent-settled" ||
          kind === "authorization-request"
        ) {
          await handleOwnerRequest(request);
        } else {
          if (request.replyTo.kind === "inbox")
            inboxResponses.set(request.replyTo.requestId, request.replyTo);
          await applyPayload(workflowToolRunRequestToTaskInputRequest(request));
        }
      } else if (envelope.kind === "task.command") {
        await applyPayload(envelope.payload as TaskRunInboundPayload);
      }
    }
  } finally {
    stopObserving();
    bodyController.abort(new Error("The task owner ended."));
    try {
      await body;
    } finally {
      await inbox.dispose();
    }
  }

  function isFinished(): boolean {
    return isTerminalTaskStatus(view.status) && dispatchAcknowledged && executorSettled;
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
    if (isReady || isRejected) {
      if (isRejected || isTerminalTaskStatus(view.status)) {
        executorSettled = true;
      } else if (input.workflow !== undefined && body === undefined && !executorSettled) {
        body = executeWorkflowBody(
          { ...input.workflow, execution: "background", owner: inbox.address },
          bodyController.signal,
          inbox,
        );
      }
      await flushPendingTraffic();
    }

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
              inboxResponses.get(payload.inputResponses[0]?.requestId ?? ""),
            )
          : undefined;
    } else if (payload.kind === "task-input-request") {
      const requested = payload.requests ?? [payload.request];
      const incoming = new Set(requested.map(readTaskInputRequestId));
      command = {
        inputRequests: [
          ...(view.status === "input_required"
            ? view.inputRequests.filter((request) => !incoming.has(readTaskInputRequestId(request)))
            : []),
          ...requested,
        ],
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
    if (isTerminalTaskStatus(result.view.status)) {
      bodyController.abort(new Error(`Task ${view.taskId} ended.`));
      await body;
      body = undefined;
      executorSettled = true;
    }
    view = result.view;
    await appendTaskViewStep({ view });
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
      for (const request of pendingTraffic.ownerRequests) await wakeTaskOwnerRequestParent(request);
    }
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

async function resolveAnsweredCommand(
  view: Extract<TaskView, { status: "input_required" }>,
  answer: TaskInboundAnswerInput,
  inboxResponse: InboxResponseRoute | undefined,
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
  return (await deliverTaskInputResponsesStep({ answer, inboxResponse, requestIds })) ===
    "delivered"
    ? { kind: "answered", requestIds }
    : undefined;
}
