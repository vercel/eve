import type {
  ActivityObserverConfig,
  DeliverHookPayload,
  RuntimeActionResultHookPayload,
  SessionAuthContext,
} from "#channel/types.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunSendCall,
} from "#execution/tools/workflow/messages.js";
import { isWorkflowTargetGone } from "#execution/tools/workflow/target-gone.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createWorkflowRuntime,
  requestWorkflowSessionEnd,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import type { ContextContainer } from "#context/container.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeAgentDispatchRequest } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import { AGENT_SESSION_ENDED_MESSAGE, renderTaskUnreachable } from "#tasks/render.js";
import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";
import {
  cancelRemoteAgentTurn,
  isRetryableRemoteAgentCancelError,
  resetRemoteAgentSession,
  resolveRemoteAgentForAction,
} from "#subagents/remote/dispatch.js";
import {
  answerRemoteAgentSession,
  continueRemoteAgentSession,
  isRetryableRemoteAgentContinueError,
  readRemoteAgentReport,
  type RemoteCallback,
} from "#subagents/remote/continue.js";
import { projectSessionCallbackResult } from "#subagents/remote/callback-route.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { RemoteTaskProtocolError } from "#subagents/remote/protocol.js";
import type { TaskAnswers } from "#tasks/input.js";
import type { ChildAddress, TaskCommand } from "#tasks/protocol.js";
import { childCallId, type TaskRecord } from "#tasks/record.js";
import { readTaskCreator } from "#tasks/results.js";
import type { ToolInputResponse } from "#tools/definition.js";
import { ownerInboxHookToken } from "#tasks/state.js";
import type { TaskEffect } from "#tasks/table.js";
import type { HardStopTarget } from "#tasks/timer-steps.js";

// Owner → child delivery: sends, new generations for idle agents, and owner commands.

const log = createLogger("tasks.transport");

const WORKFLOW_TASK_CANCEL_REASON = "The tool call was cancelled.";

/** The code of a send its task's child could not take. */
const TASK_UNREACHABLE = "TASK_UNREACHABLE";

export type CommandEffect = Extract<TaskEffect, { kind: "send" }>;

/** A send its task's child did not take: the call's error, and whether the child is gone for good. */
export interface SendFailure {
  readonly output: JsonValue;
  readonly permanent: boolean;
}

type InputCommand = Extract<TaskCommand, { readonly kind: "input" }>;

/**
 * Sends owner commands to started children without waiting for them to act.
 * A lost request is logged, never retried: the child may already have it.
 */
export async function runCommands(
  effects: readonly CommandEffect[],
  ctx: ContextContainer | undefined,
): Promise<void> {
  await Promise.all(
    effects.flatMap((effect) =>
      effect.commands.map((command) => runCommand(effect.record, command, ctx)),
    ),
  );
}

async function runCommand(
  record: TaskRecord,
  command: TaskCommand,
  ctx: ContextContainer | undefined,
): Promise<void> {
  const child = record.child;
  // Sends go through `sendTaskInput`, which knows the owner.
  if (child === undefined || command.kind !== "cancel") return;
  try {
    if (child.kind === "remote") {
      const remote = resolveRemoteChild(record, ctx);
      if (remote === undefined) return;
      // Cancel where the child runs; the registry may point at a newer deployment.
      const cancel = () =>
        cancelRemoteAgentTurn({
          remote: { ...remote, url: child.url },
          sessionId: child.sessionId,
        });
      try {
        await cancel();
      } catch (error) {
        // A cancel is safe to repeat; one more try covers a dropped or slow request.
        if (!isRetryableRemoteAgentCancelError(error)) throw error;
        await cancel();
      }
      return;
    }
    if (child.kind === "local") {
      await requestWorkflowTurnCancellation({ sessionId: child.sessionId });
      return;
    }
    await cancelWorkflowToolRun(
      { hookToken: child.commandToken, runId: child.runId },
      WORKFLOW_TASK_CANCEL_REASON,
    );
  } catch (error) {
    // The owner already recorded the cancellation; a lost request leaves the
    // child to finish on its own, and its report only confirms the stop.
    logError(log, "failed to send cancel to a task child", error, {
      childKind: child.kind,
      taskId: record.id,
    });
  }
}

/**
 * Delivers one send to a task's child. A workflow run takes it on its
 * command hook, in order with cancels. A working agent gets it as a steering
 * message for the call it is answering, with the owner's key, so the agent
 * admits it once and counts it with the answer that settles that call: in
 * its current turn, or in a next turn for the same call when it has already
 * answered. The message carries the send's output schema, which becomes the
 * turn's schema. A remote agent gets the same message over HTTP, with the
 * owner's callback for the call. Returns the call's error when the child did
 * not take it.
 */
export async function sendTaskInput(input: {
  /** The owner's remote callback alias; a remote agent answers through it. */
  readonly callbackAlias: string | undefined;
  /** The send's call, whose context a workflow run's generation takes. */
  readonly call?: WorkflowToolRunSendCall;
  readonly command: InputCommand;
  readonly ctx: ContextContainer | undefined;
  readonly ownerSessionId: string;
  readonly record: TaskRecord;
}): Promise<SendFailure | undefined> {
  const { command, record } = input;
  const child = record.child;
  const unreachable = (permanent: boolean): SendFailure => ({
    output: {
      code: TASK_UNREACHABLE,
      message: renderTaskUnreachable(record, permanent ? "ended" : "temporary"),
    },
    permanent,
  });
  if (child?.kind === "workflow") {
    const call = input.call ?? {
      callId: record.callId,
      stepIndex: 0,
      turn: { id: record.turnId, sequence: 0 },
    };
    const message: WorkflowToolRunControlMessage = {
      call,
      input: command.input,
      kind: "input",
      seq: command.seq,
    };
    try {
      await resumeHook(child.commandToken, message);
      return undefined;
    } catch (error) {
      if (isWorkflowTargetGone(error)) return unreachable(true);
      logError(log, "failed to send input to a workflow task", error, { taskId: record.id });
      return unreachable(false);
    }
  }
  const bundle = input.ctx?.get(BundleKey);
  if (child === undefined || bundle === undefined) return unreachable(false);
  const message = typeof command.input.message === "string" ? command.input.message : "";
  const outputSchema = normalizeRequestedOutputSchema(command.input.outputSchema);
  // The send's identity: a retried step resends the same key, and the agent admits it once.
  const operationId = `${record.id}:${command.seq}`;
  try {
    if (child.kind === "remote") {
      const remote = resolveRemoteChild(record, input.ctx);
      if (remote === undefined || input.callbackAlias === undefined) return unreachable(true);
      // Only the principal that started the task may send to it.
      await continueRemoteAgentSession({
        auth: readTaskCreator(record.creator).auth,
        callback: remoteCallback(childCallId(record), record.name, child, input.callbackAlias),
        message,
        operationId,
        outputSchema,
        remote: { ...remote, url: child.url },
        sessionId: child.sessionId,
        turnPolicy: "steer",
      });
      return undefined;
    }
    // Without `auth`, the child keeps acting as the principal that started
    // it, which is the sending principal: only that principal may send.
    const result = await createWorkflowRuntime({
      compiledArtifactsSource: bundle.compiledArtifactsSource,
      nodeId: record.nodeId,
    }).dispatchSession({
      command: {
        caller: {
          callId: childCallId(record),
          replyTo: { kind: "hook", token: ownerInboxHookToken(input.ownerSessionId) },
          subagentName: record.name,
        },
        kind: "send",
        operationId,
        payload: outputSchema === undefined ? { message } : { message, outputSchema },
        turnPolicy: "steer",
      },
      sessionId: child.sessionId,
    });
    return result.status === "accepted" ? undefined : unreachable(result.retryable !== true);
  } catch (error) {
    logError(log, "failed to send input to a working agent", error, {
      childKind: child.kind,
      taskId: record.id,
    });
    // A working agent that no longer speaks this protocol cannot take the input.
    if (error instanceof RemoteTaskProtocolError) {
      return { output: { code: TASK_UNREACHABLE, message: error.message }, permanent: true };
    }
    return unreachable(
      isRuntimeNoActiveSessionError(error) || !isRetryableRemoteAgentContinueError(error),
    );
  }
}

/**
 * Sends a task the answers a delivery holds for it, as the principal that
 * answered: an approval policy checks that responder, while the child keeps
 * acting as the principal that started it. A local child takes them in its
 * inbox; a remote one over HTTP, where an answer that may yet arrive stays
 * answerable (`retry`) and one that never can fails the task through the
 * owner's inbox, like a result from the child (`failed`). A workflow run's
 * question hook, named by its request ID, takes an answer or a dismissal.
 */
export async function answerTask(input: {
  readonly answers: TaskAnswers;
  readonly ctx: ContextContainer | undefined;
  /** The delivery that carried the answers; its principal and envelope travel with them. */
  readonly delivery: DeliverHookPayload;
  readonly ownerSessionId: string;
}): Promise<"delivered" | "retry" | "failed"> {
  const { deliveryMetadata, dismissed, record, responses } = input.answers;
  const child = record.child;
  if (child?.kind === "workflow") {
    const answers: (readonly [string, ToolInputResponse])[] = [
      ...responses.map(
        ({ optionId, requestId, text }) =>
          [requestId, { optionId, status: "answered" as const, text }] as const,
      ),
      ...dismissed.map((requestId) => [requestId, { status: "dismissed" as const }] as const),
    ];
    for (const [token, answer] of answers) {
      try {
        await resumeHook(token, answer);
      } catch (error) {
        if (!isWorkflowTargetGone(error)) throw error;
      }
    }
    return "delivered";
  }
  if (responses.length === 0) return "delivered";
  if (child?.kind === "local") {
    await resumeSessionInbox(
      { sessionId: child.sessionId },
      {
        ...input.delivery,
        deliveryMetadata: deliveryMetadata.length === 0 ? undefined : deliveryMetadata,
        payloads: [{ inputResponses: responses }],
      },
    );
    return "delivered";
  }
  const remote = resolveRemoteChild(record, input.ctx);
  if (child?.kind !== "remote" || remote === undefined) return "retry";
  try {
    await answerRemoteAgentSession({
      auth: input.delivery.auth ?? null,
      inputResponses: responses,
      remote: { ...remote, url: child.url },
      sessionId: child.sessionId,
    });
    return "delivered";
  } catch (error) {
    logError(log, "failed to answer a remote agent's input request", error, { taskId: record.id });
    const protocol = error instanceof RemoteTaskProtocolError;
    if (!protocol && isRetryableRemoteAgentContinueError(error)) return "retry";
    const failure = protocol
      ? { code: TASK_UNREACHABLE, message: error.message }
      : { code: "AGENT_SESSION_ENDED", message: AGENT_SESSION_ENDED_MESSAGE };
    const report: RuntimeActionResultHookPayload = {
      kind: "runtime-action-result",
      results: [
        {
          callId: childCallId(record),
          isError: true,
          kind: "subagent-result",
          origin: "child",
          outcome: {
            kind: protocol ? "parked" : "terminal",
            result: { error: failure, kind: "failed" },
            usageDelta: {
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
          output: failure,
          subagentName: record.name,
        },
      ],
      source: { kind: "remote", sessionId: child.sessionId },
    };
    await resumeHook(ownerInboxHookToken(input.ownerSessionId), report);
    return "failed";
  }
}

/**
 * The deadline's one read of a remote agent: the latest result it reported
 * for the task's current call, as its callback would have carried it.
 * `undefined` when it has not answered the call or cannot be read.
 */
export async function readRemoteTaskReport(
  record: TaskRecord,
  ctx: ContextContainer | undefined,
  /** The owner's callback token, which the child requires before it shows a report. */
  callbackToken: string,
): Promise<RuntimeSubagentChildResult | undefined> {
  const child = record.child;
  const remote = resolveRemoteChild(record, ctx);
  if (child?.kind !== "remote" || remote === undefined) return undefined;
  try {
    const report = await readRemoteAgentReport({
      callId: childCallId(record),
      callbackToken,
      remote: { ...remote, url: child.url },
      sessionId: child.sessionId,
    });
    if (report === undefined) return undefined;
    const result = projectSessionCallbackResult(report);
    return result instanceof Response || result.subagentName !== record.name ? undefined : result;
  } catch (error) {
    logError(log, "failed to read a remote agent's report at its deadline", error, {
      taskId: record.id,
    });
    return undefined;
  }
}

/** A remote on another task protocol version cannot start the work; the error says what to upgrade. */
function protocolFailure(error: RemoteTaskProtocolError): JsonValue {
  return { code: "START_FAILED", message: error.message };
}

function remoteCallback(
  callId: string,
  subagentName: string,
  child: Extract<ChildAddress, { readonly kind: "remote" }>,
  callbackAlias: string,
): RemoteCallback {
  const token = sessionInboxHookToken(callbackAlias);
  return {
    callId,
    subagentName,
    token,
    url: createWorkflowCallbackUrl(child.callbackBaseUrl, createEveCallbackRoutePath(token)),
  };
}

function resolveRemoteChild(record: TaskRecord, ctx: ContextContainer | undefined) {
  const bundle = ctx?.get(BundleKey);
  if (ctx === undefined || bundle === undefined || record.nodeId === undefined) return undefined;
  const selection = getDynamicSubagentSelection(ctx, record.nodeId);
  return resolveRemoteAgentForAction({
    dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
    nodeId: record.nodeId,
    remoteAgentName: record.name,
    registry: bundle.subagentRegistry.subagentsByNodeId,
  });
}

/** Why a retired idle task's child ends. */
export const RETIRED_IDLE_TASK_REASON = "The parent retired this idle task.";

/**
 * Ends the child of an idle task the owner no longer keeps: a local agent
 * ends as a reset session does, a remote one through its reset route, and a
 * workflow run is asked to end (a run that cannot be reached is cancelled
 * outright). A failed request is logged. Returns a local agent the request
 * did not reach, for the owner's timer to ask again and hard-stop if that
 * fails too; a remote agent it did not reach is bounded by its own session
 * lifetime.
 */
export async function retireIdleTask(
  record: TaskRecord,
  ctx: ContextContainer | undefined,
): Promise<HardStopTarget | undefined> {
  const child = record.child;
  if (child === undefined) return undefined;
  try {
    if (child.kind === "workflow") {
      await cancelWorkflowToolRun(
        { hookToken: child.commandToken, runId: child.runId },
        RETIRED_IDLE_TASK_REASON,
        { end: true },
      );
      return undefined;
    }
    if (child.kind === "local") {
      await requestWorkflowSessionEnd({
        reason: RETIRED_IDLE_TASK_REASON,
        sessionId: child.sessionId,
      });
      return undefined;
    }
    const remote = resolveRemoteChild(record, ctx);
    if (remote === undefined) return undefined;
    await resetRemoteAgentSession({
      reason: RETIRED_IDLE_TASK_REASON,
      remote: { ...remote, url: child.url },
      sessionId: child.sessionId,
    });
  } catch (error) {
    logError(log, "failed to end a retired idle task", error, {
      childKind: child.kind,
      taskId: record.id,
    });
    if (child.kind === "local") return child;
  }
  return undefined;
}

/**
 * Cancels the turn of a local child whose task no longer exists: its owner
 * stopped the task and pruned the record before the child reported
 * `task.started`, so the held cancel never reached it.
 */
export async function cancelOrphanedChild(input: {
  readonly callId: string;
  readonly sessionId: string;
}): Promise<void> {
  log.warn("cancelling a child whose task no longer exists", input);
  try {
    await requestWorkflowTurnCancellation({ sessionId: input.sessionId });
  } catch (error) {
    logError(log, "failed to cancel a child whose task no longer exists", error, input);
  }
}

/**
 * Gives an idle agent its next generation, for the send `record` now names.
 * A lost response is never retried: the child may already have accepted the
 * message.
 */
export async function deliverToChild(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly activityObserver?: ActivityObserverConfig;
  readonly auth: SessionAuthContext | null;
  readonly bundle: CompiledBundle;
  readonly child: ChildAddress;
  readonly record: TaskRecord;
  readonly replyToken: string;
}): Promise<SendFailure | undefined> {
  const { action, child, record } = input;
  const message = typeof action.input.message === "string" ? action.input.message : "";
  const outputSchema = normalizeRequestedOutputSchema(action.input.outputSchema);
  const unreachable = (permanent: boolean): SendFailure => ({
    output: {
      code: TASK_UNREACHABLE,
      message: renderTaskUnreachable(record, permanent ? "ended" : "temporary"),
    },
    permanent,
  });
  // The call's identity: a retried step resends it, and the agent admits it once.
  const operationId = `${record.turnId}:${action.callId}`;
  try {
    if (child.kind === "remote") {
      const resolved = resolveRemoteAgentForAction({
        nodeId: action.nodeId,
        remoteAgentName: record.name,
        registry: input.bundle.subagentRegistry.subagentsByNodeId,
      });
      await continueRemoteAgentSession({
        activityObserver: input.activityObserver,
        auth: input.auth,
        callback: {
          callId: action.callId,
          subagentName: record.name,
          token: input.replyToken,
          url: createWorkflowCallbackUrl(
            child.callbackBaseUrl,
            createEveCallbackRoutePath(input.replyToken),
          ),
        },
        message,
        operationId,
        outputSchema,
        remote: { ...resolved, url: child.url },
        sessionId: child.sessionId,
        turnPolicy: "queue",
      });
      return undefined;
    }
    if (child.kind !== "local") return unreachable(true);
    const result = await createWorkflowRuntime({
      compiledArtifactsSource: input.bundle.compiledArtifactsSource,
      nodeId: action.nodeId,
    }).dispatchSession({
      command: {
        auth: input.auth,
        caller: {
          activityObserver: input.activityObserver,
          callId: action.callId,
          replyTo: { kind: "hook", token: input.replyToken },
          subagentName: record.name,
        },
        kind: "send",
        operationId,
        payload: { message, outputSchema },
        turnPolicy: "queue",
      },
      sessionId: child.sessionId,
    });
    return result.status === "accepted" ? undefined : unreachable(result.retryable !== true);
  } catch (error) {
    logError(log, "task agent delivery failed", error, {
      callId: action.callId,
      taskId: record.id,
    });
    if (error instanceof RemoteTaskProtocolError) {
      return { output: protocolFailure(error), permanent: true };
    }
    return unreachable(
      isRuntimeNoActiveSessionError(error) || !isRetryableRemoteAgentContinueError(error),
    );
  }
}
