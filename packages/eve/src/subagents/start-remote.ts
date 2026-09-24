import type { DispatchOutcome, RuntimeSession } from "#subagents/start-outcome.js";
import { deriveChildActivityObserverConfig } from "#execution/activity-work.js";
import { createRemoteAgentStartFailureResult } from "#execution/dispatch-action-failures.js";
import { deriveAgentOperationId } from "#subagents/operation-id.js";
import {
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#subagents/remote-dispatch.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeRemoteAgentDispatchRequest } from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { SubagentParentContext } from "#subagents/invocation.js";

const log = createLogger("execution.subagent-start-remote");

/** Starts one remote subagent after dispatch planning has selected its target. */
export async function startRemoteSubagent(input: {
  readonly action: RuntimeRemoteAgentDispatchRequest;
  readonly auth: Parameters<typeof startRemoteAgentSession>[0]["auth"];
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly capabilities: Parameters<typeof startRemoteAgentSession>[0]["capabilities"];
  readonly dynamicRemoteAgent?: NonNullable<
    Parameters<typeof resolveRemoteAgentForAction>[0]["dynamicRemoteAgent"]
  >;
  readonly initiatorAuth: Parameters<typeof startRemoteAgentSession>[0]["initiatorAuth"];
  readonly parent: SubagentParentContext;
  readonly activityObserver?: Parameters<typeof startRemoteAgentSession>[0]["activityObserver"];
  readonly session: RuntimeSession;
}): Promise<DispatchOutcome> {
  const { action } = input;
  const activityObserver = deriveChildActivityObserverConfig({
    activityObserver: input.activityObserver,
    callId: action.callId,
    kind: "remote-agent",
    name: action.remoteAgentName,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.parent.lineage.turn.id,
  });

  // Preflight resolution failures happen before ownership exists, so they
  // reject before the child exists.
  let callbackBaseUrl: string;
  let resolvedRemote: ReturnType<typeof resolveRemoteAgentForAction>;
  try {
    if (input.callbackBaseUrl === undefined) {
      throw new Error("Cannot dispatch remote agent without a callback base URL.");
    }
    callbackBaseUrl = input.callbackBaseUrl;
    resolvedRemote = resolveRemoteAgentForAction({
      dynamicRemoteAgent: input.dynamicRemoteAgent,
      nodeId: action.nodeId,
      remoteAgentName: action.remoteAgentName,
      registry: input.bundle.subagentRegistry.subagentsByNodeId,
    });
  } catch (error) {
    logError(log, "remote agent start failed", error, {
      remoteAgentName: action.remoteAgentName,
      nodeId: action.nodeId,
      callId: action.callId,
    });
    return { kind: "error", result: createRemoteAgentStartFailureResult({ action, error }) };
  }

  const operationId = deriveAgentOperationId({
    callId: action.callId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.parent.lineage.turn.id,
  });
  const credentialResolver =
    input.dynamicRemoteAgent === undefined
      ? action.nodeId
      : input.dynamicRemoteAgent.credentialsStepId;
  try {
    const child = await startRemoteAgentSession({
      action,
      auth: input.auth,
      callbackBaseUrl,
      capabilities: input.capabilities,
      originAudience: input.parent.originAudience,
      initiatorAuth: input.initiatorAuth,
      operationId,
      parent: input.parent,
      activityObserver,
      remote: resolvedRemote,
      session: input.session,
    });
    return {
      kind: "started",
      remote: {
        callbackBaseUrl,
        credentialResolver,
        sessionId: child.sessionId,
        url: resolvedRemote.url,
      },
    };
  } catch (error) {
    logError(log, "remote agent start failed", error, {
      remoteAgentName: action.remoteAgentName,
      nodeId: action.nodeId,
      callId: action.callId,
    });
    return { kind: "error", result: createRemoteAgentStartFailureResult({ action, error }) };
  }
}
