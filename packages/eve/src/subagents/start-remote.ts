import { createCallbackCapability } from "#subagents/callback-capability.js";
import type { ReplyTarget } from "#execution/inbox/types.js";
import type { DispatchOutcome, RuntimeSession } from "#subagents/handle-dispatch.js";
import { deriveChildActivityObserverConfig } from "#execution/activity-work.js";
import { createRemoteAgentStartFailureResult } from "#execution/dispatch-action-failures.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
import {
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#subagents/remote-dispatch.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeRemoteAgentDispatchRequest } from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

const log = createLogger("execution.subagent-start-remote");

/** Starts one remote subagent after dispatch planning has selected its target. */
export async function startRemoteSubagent(input: {
  readonly action: RuntimeRemoteAgentDispatchRequest;
  readonly auth: Parameters<typeof startRemoteAgentSession>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly originAudience: ChannelAudience;
  readonly currentSession: RuntimeSession;
  readonly dynamicRemoteAgent?: NonNullable<
    Parameters<typeof resolveRemoteAgentForAction>[0]["dynamicRemoteAgent"]
  >;
  readonly initiatorAuth: Parameters<typeof startRemoteAgentSession>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly parentReplyTo: ReplyTarget;
  readonly parentTraceContext: Parameters<typeof startRemoteAgentSession>[0]["parentTraceContext"];
  readonly activityObserver?: Parameters<typeof startRemoteAgentSession>[0]["activityObserver"];
  readonly session: RuntimeSession;
  readonly taskId?: string;
}): Promise<DispatchOutcome> {
  const { action } = input;
  const activityObserver = deriveChildActivityObserverConfig({
    activityObserver: input.activityObserver,
    callId: action.callId,
    kind: "remote-agent",
    name: action.remoteAgentName,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });

  // Preflight resolution failures happen before ownership exists, so they
  // reject without touching the handle store.
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
    return {
      kind: "error",
      result: createRemoteAgentStartFailureResult({ action, error }),
      session: input.currentSession,
    };
  }

  const { operation } = mintStartOperation({
    callId: action.callId,
    name: action.remoteAgentName,
    nodeId: action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });
  const credentialResolver = {
    resolverId:
      input.dynamicRemoteAgent === undefined
        ? action.nodeId
        : input.dynamicRemoteAgent.credentialsStepId,
  };
  try {
    const child = await startRemoteAgentSession({
      action,
      auth: input.auth,
      callbackBaseUrl,
      callbackToken: createCallbackCapability(input.parentReplyTo),
      originAudience: input.originAudience,
      initiatorAuth: input.initiatorAuth,
      operationId: operation.id,
      parentTraceContext: input.parentTraceContext,
      activityObserver,
      remote: resolvedRemote,
      session: input.session,
      taskId: input.taskId,
    });
    const address = {
      callbackBaseUrl,
      credentialResolver,
      kind: "agent/remote",
      sessionId: child.sessionId,
      url: resolvedRemote.url,
    } as const;
    return {
      address,
      callId: action.callId,
      kind: "called",
      name: action.name,
      session: input.currentSession,
      toolName: action.remoteAgentName,
    };
  } catch (error) {
    logError(log, "remote agent start failed", error, {
      remoteAgentName: action.remoteAgentName,
      nodeId: action.nodeId,
      callId: action.callId,
    });
    return {
      kind: "error",
      result: createRemoteAgentStartFailureResult({ action, error }),
      session: input.currentSession,
    };
  }
}
