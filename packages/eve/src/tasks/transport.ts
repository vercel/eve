import type { ActivityObserverConfig, SessionAuthContext } from "#channel/types.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createWorkflowRuntime,
  requestWorkflowSessionEnd,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import type { ContextContainer } from "#context/container.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeAgentDispatchRequest } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import { AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";
import { AGENT_SESSION_ENDED_MESSAGE, renderAgentUnreachable } from "#tasks/render.js";
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
import type { InputResponse } from "#shared/input.js";
import { RemoteTaskProtocolError } from "#subagents/remote/protocol.js";
import type { ChildAddress, TaskCommand, TaskError } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { readTaskCreator } from "#tasks/results.js";
import { ownerInboxHookToken } from "#tasks/state.js";
import type { TaskEffect } from "#tasks/table.js";
import type { HardStopTarget } from "#tasks/timer-steps.js";

// Owner → child delivery: new generations for idle agents and owner commands.

const log = createLogger("tasks.transport");

const WORKFLOW_TASK_CANCEL_REASON = "The tool call was cancelled.";

export type CommandEffect = Extract<TaskEffect, { kind: "send" }>;

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
  // Held messages go through `flushHeldCommands`, which knows the owner.
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
 * Sends a steering message to a working agent for its current generation's
 * call, with the owner's key, so the agent admits the message once and
 * reports receiving it when it answers that call: in its current turn, in
 * its next turn for the same call when it is holding that call for its own
 * background work, or as a new turn for the call when it has already
 * answered. A remote agent gets the same message over HTTP, with the owner's
 * callback for the call. Returns the call's error output when the message
 * did not reach the agent.
 */
export async function sendAgentMessage(input: {
  /** The owner's remote callback alias; a remote agent answers through it. */
  readonly callbackAlias: string | undefined;
  readonly command: Extract<TaskCommand, { readonly kind: "message" }>;
  readonly ctx: ContextContainer | undefined;
  readonly ownerSessionId: string;
  readonly record: TaskRecord;
}): Promise<JsonValue | undefined> {
  const { command, record } = input;
  const child = record.child;
  const unreachable = (permanent: boolean): JsonValue => ({
    code: AGENT_UNREACHABLE,
    message: renderAgentUnreachable(record.id, permanent ? "gone" : "temporary"),
  });
  const bundle = input.ctx?.get(BundleKey);
  if (child === undefined || bundle === undefined) return unreachable(false);
  try {
    if (child.kind === "remote") {
      const remote = resolveRemoteChild(record, input.ctx);
      if (remote === undefined || input.callbackAlias === undefined) return unreachable(true);
      // Only the principal that started the generation may steer it.
      await continueRemoteAgentSession({
        auth: readTaskCreator(record.creator).auth,
        callback: remoteCallback(record.callId, record.name, child, input.callbackAlias),
        message: command.message,
        operationId: command.key,
        remote: { ...remote, url: child.url },
        sessionId: child.sessionId,
        turnPolicy: "steer",
      });
      return undefined;
    }
    if (child.kind !== "local") return unreachable(true);
    // Without `auth`, the child keeps acting as the principal that started
    // it, which is the steering principal: only that principal may steer.
    const result = await createWorkflowRuntime({
      compiledArtifactsSource: bundle.compiledArtifactsSource,
      nodeId: record.nodeId,
    }).dispatchSession({
      command: {
        caller: {
          callId: record.callId,
          replyTo: { kind: "hook", token: ownerInboxHookToken(input.ownerSessionId) },
          subagentName: record.name,
        },
        kind: "send",
        operationId: command.key,
        payload: { message: command.message },
        turnPolicy: "steer",
      },
      sessionId: child.sessionId,
    });
    return result.status === "accepted" ? undefined : unreachable(result.retryable !== true);
  } catch (error) {
    logError(log, "failed to send a message to a working agent", error, {
      childKind: child.kind,
      taskId: record.id,
    });
    // A working agent that no longer speaks this protocol cannot take the message.
    if (error instanceof RemoteTaskProtocolError) {
      return { code: AGENT_UNREACHABLE, message: error.message };
    }
    return unreachable(
      isRuntimeNoActiveSessionError(error) || !isRetryableRemoteAgentContinueError(error),
    );
  }
}

/**
 * What became of answers sent to a remote agent: they reached it; they did
 * not but may on a later try, so the requests stay answerable; or they never
 * can, because the agent's session is gone or speaks another protocol, so
 * the task fails with `error`.
 */
export type RemoteAnswerOutcome =
  | { readonly kind: "answered" }
  | { readonly kind: "retry" }
  | { readonly kind: "failed"; readonly error: TaskError; readonly childEnded: boolean };

/**
 * Answers input requests a remote agent surfaced, as the principal that
 * answered: an approval policy checks that responder. The agent itself keeps
 * acting as the principal that started it, because a delegated session never
 * takes on an answer's principal.
 */
export async function answerRemoteTask(input: {
  /** The answering principal, forwarded when the definition forwards the caller identity. */
  readonly auth: SessionAuthContext | null;
  readonly ctx: ContextContainer | undefined;
  readonly inputResponses: readonly InputResponse[];
  readonly record: TaskRecord;
}): Promise<RemoteAnswerOutcome> {
  const { record } = input;
  const child = record.child;
  const remote = resolveRemoteChild(record, input.ctx);
  if (child?.kind !== "remote" || remote === undefined) return { kind: "retry" };
  try {
    await answerRemoteAgentSession({
      auth: input.auth,
      inputResponses: input.inputResponses,
      remote: { ...remote, url: child.url },
      sessionId: child.sessionId,
    });
    return { kind: "answered" };
  } catch (error) {
    logError(log, "failed to answer a remote agent's input request", error, {
      taskId: record.id,
    });
    if (error instanceof RemoteTaskProtocolError) {
      return {
        childEnded: false,
        error: { code: AGENT_UNREACHABLE, message: error.message },
        kind: "failed",
      };
    }
    if (!isRetryableRemoteAgentContinueError(error)) {
      return {
        childEnded: true,
        error: { code: "AGENT_SESSION_ENDED", message: AGENT_SESSION_ENDED_MESSAGE },
        kind: "failed",
      };
    }
    return { kind: "retry" };
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
      callId: record.callId,
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

/** Why a retired idle agent's session ends. */
export const RETIRED_IDLE_AGENT_REASON = "The parent retired this idle agent.";

/**
 * Ends the session of an idle agent the owner no longer keeps: a local agent
 * ends as a reset session does, and a remote one through its reset route. A
 * failed request is logged. Returns a local agent the request did not reach,
 * for the owner's timer to ask again and hard-stop if that fails too; a
 * remote agent it did not reach is bounded by its own session lifetime.
 */
export async function retireIdleAgent(
  record: TaskRecord,
  ctx: ContextContainer | undefined,
): Promise<HardStopTarget | undefined> {
  const child = record.child;
  if (child === undefined || child.kind === "workflow") return undefined;
  try {
    if (child.kind === "local") {
      await requestWorkflowSessionEnd({
        reason: RETIRED_IDLE_AGENT_REASON,
        sessionId: child.sessionId,
      });
      return undefined;
    }
    const remote = resolveRemoteChild(record, ctx);
    if (remote === undefined) return undefined;
    await resetRemoteAgentSession({
      reason: RETIRED_IDLE_AGENT_REASON,
      remote: { ...remote, url: child.url },
      sessionId: child.sessionId,
    });
  } catch (error) {
    logError(log, "failed to end a retired idle agent", error, {
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
 * Gives an idle agent its next generation. A lost response is never retried:
 * the child may already have accepted the message.
 */
export async function deliverToChild(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly activityObserver?: ActivityObserverConfig;
  readonly auth: SessionAuthContext | null;
  readonly bundle: CompiledBundle;
  readonly child: ChildAddress;
  readonly record: TaskRecord;
  readonly replyToken: string;
}): Promise<JsonValue | undefined> {
  const { action, child, record } = input;
  const message = typeof action.input.message === "string" ? action.input.message : "";
  const outputSchema = normalizeRequestedOutputSchema(action.input.outputSchema);
  const unreachable = (permanent: boolean): JsonValue => ({
    code: AGENT_UNREACHABLE,
    message: renderAgentUnreachable(record.id, permanent ? "gone" : "temporary"),
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
    if (error instanceof RemoteTaskProtocolError) return protocolFailure(error);
    return unreachable(
      isRuntimeNoActiveSessionError(error) || !isRetryableRemoteAgentContinueError(error),
    );
  }
}
