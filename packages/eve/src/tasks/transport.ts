import type { ActivityObserverConfig, SessionAuthContext } from "#channel/types.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createWorkflowRuntime,
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
import { renderAgentUnreachable } from "#tasks/render.js";
import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";
import {
  cancelRemoteAgentTurn,
  continueRemoteAgentSession,
  isRetryableRemoteAgentContinueError,
  resolveRemoteAgentForAction,
} from "#subagents/remote-dispatch.js";
import type { ChildAddress, TaskCommand } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { readTaskCreator } from "#tasks/results.js";
import { ownerInboxHookToken } from "#tasks/state.js";
import type { TaskEffect } from "#tasks/table.js";

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
      await cancelRemoteAgentTurn({
        remote: { ...remote, url: child.url },
        sessionId: child.sessionId,
      });
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
 * Sends a steering message to a working agent. A local agent receives it for
 * its current generation's call, with the owner's key, so it admits the
 * message once and reports receiving it when it answers that call: in its
 * current turn, in its next turn for the same call when it is holding that
 * call for its own background work, or as a new turn for the call when it
 * has already answered. A remote agent receives it without a caller and
 * applies it to its current turn. Returns the call's error output when the
 * message did not reach the agent.
 */
export async function sendAgentMessage(input: {
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
      if (remote === undefined) return unreachable(true);
      // The child's current generation already has the owner's callback. Only
      // the principal that started that generation may steer it.
      await continueRemoteAgentSession({
        auth: readTaskCreator(record.creator).auth,
        message: command.message,
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
        payload: { message: command.message },
        steerKey: command.key,
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
    return unreachable(
      isRuntimeNoActiveSessionError(error) || !isRetryableRemoteAgentContinueError(error),
    );
  }
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
        outputSchema,
        remote: { ...resolved, url: child.url },
        sessionId: child.sessionId,
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
        payload: { message, outputSchema },
      },
      sessionId: child.sessionId,
    });
    return result.status === "accepted" ? undefined : unreachable(result.retryable !== true);
  } catch (error) {
    logError(log, "task agent delivery failed", error, {
      callId: action.callId,
      taskId: record.id,
    });
    return unreachable(isRuntimeNoActiveSessionError(error));
  }
}
