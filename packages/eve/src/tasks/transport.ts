import type { ActivityObserverConfig, SessionAuthContext } from "#channel/types.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  createWorkflowRuntime,
  requestWorkflowTurnCancellation,
} from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { RuntimeAgentDispatchRequest } from "#shared/action-types.js";
import type { JsonValue } from "#shared/json.js";
import { AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";
import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";
import {
  cancelRemoteAgentTurn,
  continueRemoteAgentSession,
  resolveRemoteAgentForAction,
} from "#subagents/remote-dispatch.js";
import type { ChildAddress, TaskCommand } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import type { TaskEffect } from "#tasks/table.js";

// Owner → child delivery: new generations for idle agents and owner commands.

const log = createLogger("tasks.transport");

export type CommandEffect = Extract<TaskEffect, { kind: "send" }>;

/** Sends owner commands to started children. Only `cancel` is issued before P2. */
export async function runCommands(
  effects: readonly CommandEffect[],
  bundle: CompiledBundle | undefined,
): Promise<void> {
  await Promise.all(
    effects.flatMap((effect) =>
      effect.commands.map((command) => runCommand(effect.record, command, bundle)),
    ),
  );
}

async function runCommand(
  record: TaskRecord,
  command: TaskCommand,
  bundle: CompiledBundle | undefined,
): Promise<void> {
  const child = record.child;
  if (child === undefined || command.kind !== "cancel") return;
  try {
    if (child.kind === "remote") {
      if (bundle === undefined || record.nodeId === undefined) return;
      const resolved = resolveRemoteAgentForAction({
        nodeId: record.nodeId,
        remoteAgentName: record.name,
        registry: bundle.subagentRegistry.subagentsByNodeId,
      });
      await cancelRemoteAgentTurn({
        remote: { ...resolved, url: child.url },
        sessionId: child.sessionId,
      });
      return;
    }
    if (child.kind === "local") {
      await requestWorkflowTurnCancellation({ sessionId: child.sessionId });
    }
  } catch (error) {
    // The owner already recorded the cancellation; a lost request leaves the
    // child to finish on its own, and its report is dropped as a duplicate.
    logError(log, "failed to send cancel to a task child", error, {
      childSessionId: child.kind === "workflow" ? child.runId : child.sessionId,
      taskId: record.id,
    });
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
    message: permanent
      ? `Agent "${record.id}" is no longer reachable. Omit agentId to start a new agent.`
      : `Agent "${record.id}" is temporarily unreachable. Try again.`,
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
