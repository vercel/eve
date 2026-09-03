/** Continuation delivery for task-owned agent sessions. */

import type { SessionAuthContext } from "#channel/types.js";
import { AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";
import type { AgentAddress, AgentIdentity } from "#subagents/handles/store.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeRemoteAgentDispatchRequest,
  RuntimeSubagentDispatchRequest,
  RuntimeSubagentDispatchFailure,
} from "#shared/action-types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import {
  continueRemoteAgentSession,
  isAmbiguousRemoteAgentContinueError,
  isRetryableRemoteAgentContinueError,
  resolveRemoteAgentForAction,
} from "#subagents/remote-dispatch.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import type { hydrateDurableSession } from "#execution/session.js";
import { normalizeRequestedOutputSchema } from "#subagents/invocation.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import { createLogger, logError } from "#internal/logging.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { err, ok, type Result } from "#shared/result.js";
import { readTaskIdFromInboxToken } from "#tasks/task-inbox-token.js";
import type { TaskOwnedAgentHandle } from "#subagents/handles/store.js";

const log = createLogger("execution.agent-handle-dispatch");

/** Agent-task requests that may address an agent handle via `agentId`. */
export type RuntimeAgentHandleAction =
  | RuntimeRemoteAgentDispatchRequest
  | RuntimeSubagentDispatchRequest;

/** Narrows an action to the kinds that may carry an `agentId` continuation. */
export function isAgentHandleAction(
  action: RuntimeAgentDispatchRequest,
): action is RuntimeAgentHandleAction {
  return action.kind === "subagent-call" || action.kind === "remote-agent-call";
}

/** Hydrated parent session snapshot threaded through dispatch. */
export type RuntimeSession = ReturnType<typeof hydrateDurableSession>;

/**
 * Outcome of dispatching one planned agent task: an adopted child ready for
 * the `subagent.called` emission tail, or a per-task error result.
 * Either way the (possibly updated) session snapshot rides along.
 *
 * `address` is the same confirmed {@link AgentAddress} recorded on the
 * child's running handle; consumers project it into wire shapes (e.g. the
 * flat `childSessionId` / `remote` fields of `subagent.called`) at the
 * emission site instead of this type re-encoding them.
 */
export type DispatchOutcome =
  | {
      readonly address: AgentAddress;
      readonly callId: string;
      readonly kind: "called";
      readonly name: string;
      readonly session: RuntimeSession;
      readonly toolName: string;
    }
  | {
      /** Trace already acknowledged by the addressed child before delivery failed. */
      readonly childTraceId?: string | undefined;
      readonly deliveryAmbiguous?: boolean;
      readonly deliveryPermanent?: boolean;
      readonly kind: "error";
      readonly result: RuntimeSubagentDispatchFailure;
      readonly session: RuntimeSession;
    };

/** Delivers a continuation after the session handle store atomically claimed it for one owner. */
export async function dispatchToClaimedAgentAddress(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly auth: SessionAuthContext | null;
  readonly bundle: CompiledBundle;
  readonly currentSession: RuntimeSession;
  readonly parentToken: string;
  readonly handle: Extract<TaskOwnedAgentHandle, { phase: "claimed" }>;
  readonly taskId?: string;
}): Promise<DispatchOutcome> {
  return await dispatchToAgentAddress(input);
}

/** Delivers a continuation to an already-claimed local or remote agent address. */
async function dispatchToAgentAddress(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly auth: SessionAuthContext | null;
  readonly bundle: CompiledBundle;
  readonly currentSession: RuntimeSession;
  readonly parentToken: string;
  readonly handle: { readonly address: AgentAddress; readonly identity: AgentIdentity };
  readonly taskId?: string;
}): Promise<DispatchOutcome> {
  const { action, handle } = input;
  const agentId = handle.identity.id;

  const delivery = await deliverToAgentAddress({
    action,
    address: handle.address,
    auth: input.auth,
    bundle: input.bundle,
    identity: handle.identity,
    parentToken: input.parentToken,
    taskId: input.taskId,
  });
  if (!delivery.ok) {
    const { cause, permanent } = delivery.error;
    logError(log, "task agent delivery failed", cause, {
      agentId,
      callId: action.callId,
      nodeId: handle.identity.nodeId,
      permanent,
      subagentName: handle.identity.name,
    });
    return {
      childTraceId: handle.address.traceId,
      deliveryAmbiguous: delivery.error.deliveryAmbiguous,
      deliveryPermanent: permanent,
      kind: "error",
      result: createAgentErrorResult({
        action,
        code: AGENT_UNREACHABLE,
        message: permanent
          ? `Agent "${handle.identity.name}" with id "${agentId}" is no longer reachable.`
          : `Agent "${handle.identity.name}" with id "${agentId}" is temporarily unreachable. Try again.`,
      }),
      session: input.currentSession,
    };
  }

  return {
    address: handle.address,
    callId: action.callId,
    kind: "called",
    name: action.name,
    session: input.currentSession,
    toolName: handle.identity.name,
  };
}

/**
 * Attempts the continuation delivery once and classifies the failure.
 *
 * Transient failures are never retried automatically: the callee may have
 * accepted the message even though the response was lost, so a re-send could
 * deliver the same turn twice. The caller surfaces a retryable
 * AGENT_UNREACHABLE instead and the model decides whether to try again.
 * Throwing is equally unsafe — a durable-step retry would re-dispatch
 * already-started siblings.
 */
async function deliverToAgentAddress(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly address: AgentAddress;
  readonly auth: SessionAuthContext | null;
  readonly bundle: CompiledBundle;
  readonly identity: AgentIdentity;
  readonly parentToken: string;
  readonly taskId?: string;
}): Promise<
  Result<
    void,
    { readonly cause: unknown; readonly deliveryAmbiguous: boolean; readonly permanent: boolean }
  >
> {
  const { action, address, bundle, identity } = input;

  if (address.kind === "agent/remote") {
    let resolvedRemote;
    try {
      resolvedRemote = resolveRemoteAgentForAction({
        nodeId: identity.nodeId,
        remoteAgentName: identity.name,
        registry: bundle.subagentRegistry.subagentsByNodeId,
      });
    } catch (error) {
      // The agent's node is gone from the compiled bundle; no retry can
      // reach this handle again.
      return err({ cause: error, deliveryAmbiguous: false, permanent: true });
    }
    try {
      await continueRemoteAgentSession({
        auth: input.auth,
        callback: {
          callId: action.callId,
          subagentName: identity.name,
          taskId: input.taskId ?? readTaskIdFromInboxToken(input.parentToken),
          token: input.parentToken,
          url: createWorkflowCallbackUrl(
            address.callbackBaseUrl,
            createEveCallbackRoutePath(input.parentToken),
          ),
        },
        message: readSubagentMessage(action),
        outputSchema: normalizeRequestedOutputSchema(action.input.outputSchema),
        remote: { ...resolvedRemote, url: address.url },
        sessionId: address.sessionId,
      });
    } catch (error) {
      return err({
        cause: error,
        deliveryAmbiguous: isAmbiguousRemoteAgentContinueError(error),
        permanent: !isRetryableRemoteAgentContinueError(error),
      });
    }
    return ok(undefined);
  }

  const childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: bundle.compiledArtifactsSource,
    nodeId: identity.nodeId,
  });
  try {
    const result = await childRuntime.dispatchSession({
      command: {
        auth: input.auth,
        caller: {
          callId: action.callId,
          replyTo: { kind: "hook", token: input.parentToken },
          subagentName: identity.name,
          taskId: input.taskId ?? readTaskIdFromInboxToken(input.parentToken),
        },
        kind: "send",
        payload: {
          message: readSubagentMessage(action),
          outputSchema: normalizeRequestedOutputSchema(action.input.outputSchema),
        },
      },
      sessionId: address.sessionId,
    });
    if (result.status === "session_not_active") {
      return err({
        cause: new Error(`Agent session "${address.sessionId}" is no longer active.`),
        deliveryAmbiguous: false,
        permanent: true,
      });
    }
  } catch (error) {
    const permanent = isRuntimeNoActiveSessionError(error);
    return err({ cause: error, deliveryAmbiguous: !permanent, permanent });
  }
  return ok(undefined);
}

export function createAgentErrorResult(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly code: string;
  readonly message: string;
}): RuntimeSubagentDispatchFailure {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: input.code,
      message: input.message,
    },
    subagentName:
      input.action.kind === "remote-agent-call"
        ? input.action.remoteAgentName
        : input.action.subagentName,
  };
}

function readSubagentMessage(action: RuntimeAgentHandleAction): string {
  return typeof action.input.message === "string" ? action.input.message : "";
}
