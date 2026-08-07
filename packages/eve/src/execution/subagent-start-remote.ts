import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { createRemoteAgentStartFailureResult } from "#execution/dispatch-action-failures.js";
import { mintStartOperation } from "#execution/dispatch-start-operation.js";
import {
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import {
  confirmAgentStarted,
  confirmTaskAgentAddress,
  prepareAgentStart,
  rejectAgentEffect,
} from "#harness/handles/transitions.js";
import { createLogger, logError } from "#internal/logging.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.subagent-start-remote");

/** Starts one remote subagent after dispatch planning has selected its target. */
export async function startRemoteSubagent(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly auth: Parameters<typeof startRemoteAgentSession>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly currentSession: RuntimeSession;
  readonly dynamicRemoteAgent?: NonNullable<
    Parameters<typeof resolveRemoteAgentForAction>[0]["dynamicRemoteAgent"]
  >;
  readonly initiatorAuth: Parameters<typeof startRemoteAgentSession>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly persistentSessions: boolean;
  readonly session: RuntimeSession;
  readonly taskOwned: boolean;
}): Promise<DispatchOutcome> {
  const { action } = input;

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

  const { identity, operation } = mintStartOperation({
    callId: action.callId,
    name: action.remoteAgentName,
    nodeId: action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });
  const preparedSession = prepareAgentStart(input.currentSession, {
    identity,
    operation,
    target: { callbackBaseUrl, kind: "agent/remote", url: resolvedRemote.url },
  });

  try {
    const child = await startRemoteAgentSession({
      action,
      auth: input.auth,
      callbackBaseUrl,
      callbackToken: input.parentContinuationToken,
      initiatorAuth: input.initiatorAuth,
      operationId: operation.id,
      persistentSessions: input.persistentSessions,
      remote: resolvedRemote,
      session: input.session,
    });
    if (input.taskOwned && child.continuationToken === undefined) {
      throw new Error(
        `Remote agent "${action.remoteAgentName}" does not support task continuations.`,
      );
    }
    const address = {
      callbackBaseUrl,
      kind: "agent/remote",
      sessionId: child.sessionId,
      url: resolvedRemote.url,
      ...(child.continuationToken === undefined
        ? {}
        : { continuationToken: child.continuationToken }),
    } as const;
    return {
      address,
      callId: action.callId,
      kind: "called",
      name: action.name,
      session: input.taskOwned
        ? confirmTaskAgentAddress(preparedSession, { address, operationId: operation.id })
        : confirmAgentStarted(preparedSession, { address, operationId: operation.id }),
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
      session: rejectAgentEffect(preparedSession, {
        disposition: "dead",
        operationId: operation.id,
      }),
    };
  }
}
