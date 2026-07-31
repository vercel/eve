/**
 * Continuation dispatch for stored agent handles.
 *
 * Owns the `agentId` leg of the runtime-action dispatch step: resolving a
 * model-supplied agentId against the session's handle store via
 * `prepareAgentContinuation`, delivering the follow-up message to the
 * address the running handle records, and resolving delivery failures as
 * dead (handle deleted) or retryable (handle restored to `parked`).
 */

import {
  AGENT_BUSY,
  AGENT_MISMATCH,
  AGENT_UNKNOWN,
  AGENT_UNREACHABLE,
} from "#harness/agent-handle-errors.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import type { AgentAddress, AgentHandle, ContinueOperation } from "#harness/handles/store.js";
import { prepareAgentContinuation, rejectAgentEffect } from "#harness/handles/transitions.js";
import type {
  RuntimeActionRequest,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentDispatchFailure,
} from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import {
  continueRemoteAgentSession,
  isRetryableRemoteAgentContinueError,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import type { hydrateDurableSession } from "#execution/session.js";
import { normalizeRequestedOutputSchema } from "#execution/subagent-invocation.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import { createLogger, logError } from "#internal/logging.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { err, ok, type Result } from "#shared/result.js";

const log = createLogger("execution.agent-handle-dispatch");

/** Runtime action kinds that may address an agent handle via `agentId`. */
export type RuntimeAgentHandleAction =
  | RuntimeRemoteAgentCallActionRequest
  | RuntimeSubagentCallActionRequest;

/** Narrows an action to the kinds that may carry an `agentId` continuation. */
export function isAgentHandleAction(
  action: RuntimeActionRequest,
): action is RuntimeAgentHandleAction {
  return action.kind === "subagent-call" || action.kind === "remote-agent-call";
}

/** Hydrated parent session snapshot threaded through dispatch. */
export type RuntimeSession = ReturnType<typeof hydrateDurableSession>;

/**
 * Outcome of dispatching one planned runtime action: an adopted child ready
 * for the `subagent.called` emission tail, or a per-action error result.
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
      readonly kind: "error";
      readonly result: RuntimeSubagentDispatchFailure;
      readonly session: RuntimeSession;
    };

/**
 * Delivers one `agentId` continuation to the child the handle names.
 *
 * Unknown ids, name mismatches, and busy handles report `AGENT_UNKNOWN` /
 * `AGENT_MISMATCH` / `AGENT_BUSY` without touching the store. Delivery
 * failures report `AGENT_UNREACHABLE`: permanent ones resolve the handle as
 * dead, transient ones restore it to `parked` so the model can retry the
 * same agentId.
 */
export async function dispatchToAgentHandle(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string;
  readonly bundle: CompiledBundle;
  readonly currentSession: RuntimeSession;
  readonly parentToken: string;
  readonly parentTurnId: string;
}): Promise<DispatchOutcome> {
  const { action, agentId, bundle } = input;
  const invokedName =
    action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
  const operation: ContinueOperation = {
    callId: action.callId,
    id: deriveAgentOperationId({
      callId: action.callId,
      parentSessionId: input.currentSession.sessionId,
      parentTurnId: input.parentTurnId,
    }),
    kind: "continue",
    parentTurnId: input.parentTurnId,
    // Placeholder: prepareAgentContinuation records the handle's actual
    // pre-delivery status so a retryable rejection can restore it.
    previousStatus: "",
  };
  // Prepared against the in-progress session so a handle resolved earlier in
  // this batch is already gone.
  const prepared = prepareAgentContinuation(input.currentSession, {
    agentId,
    invokedName,
    operation,
  });

  switch (prepared.kind) {
    case "unknown":
      return {
        kind: "error",
        result: createAgentErrorResult({
          action,
          code: AGENT_UNKNOWN,
          message: `No agent from the <agents> list found for id "${agentId}".`,
        }),
        session: input.currentSession,
      };
    case "mismatch":
      return {
        kind: "error",
        result: createAgentErrorResult({
          action,
          code: AGENT_MISMATCH,
          message: `Agent "${agentId}" from the <agents> list does not belong to "${invokedName}".`,
        }),
        session: input.currentSession,
      };
    case "busy":
      return {
        kind: "error",
        result: createAgentErrorResult({
          action,
          code: AGENT_BUSY,
          message: `Agent "${agentId}" is still working on its previous request. Wait for its result before continuing it.`,
        }),
        session: input.currentSession,
      };
    case "ready":
      break;
  }

  const { handle } = prepared;
  const delivery = await deliverToAgentHandle({
    action,
    bundle,
    handle,
    parentToken: input.parentToken,
  });
  if (!delivery.ok) {
    const { cause, permanent } = delivery.error;
    logError(log, "agent delivery failed", cause, {
      agentId,
      callId: action.callId,
      nodeId: handle.identity.nodeId,
      permanent,
      subagentName: handle.identity.name,
    });
    // Only permanent failures resolve the handle as dead (forfeiting the
    // child's accumulated conversation); a transiently unreachable agent is
    // restored to `parked` so the model can retry the same agentId.
    return {
      kind: "error",
      result: createAgentErrorResult({
        action,
        code: AGENT_UNREACHABLE,
        message: permanent
          ? `Agent "${handle.identity.name}" with id "${agentId}" is no longer reachable.`
          : `Agent "${handle.identity.name}" with id "${agentId}" is temporarily unreachable. Try again.`,
      }),
      session: rejectAgentEffect(prepared.session, {
        disposition: permanent ? "dead" : "retryable",
        operationId: operation.id,
      }),
    };
  }

  return {
    address: handle.address,
    callId: action.callId,
    kind: "called",
    name: action.name,
    session: prepared.session,
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
async function deliverToAgentHandle(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly bundle: CompiledBundle;
  readonly handle: Extract<AgentHandle, { phase: "running" }>;
  readonly parentToken: string;
}): Promise<Result<void, { readonly cause: unknown; readonly permanent: boolean }>> {
  const { action, bundle, handle } = input;
  const { address, identity } = handle;

  if (address.kind === "agent/remote") {
    // A remote deployment old enough to omit a continuationToken cannot
    // receive continuations; no retry can change that.
    if (address.continuationToken === undefined) {
      return err({
        cause: new Error(
          `Remote agent "${identity.name}" returned no continuationToken at start; its deployment does not support continuations.`,
        ),
        permanent: true,
      });
    }
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
      return err({ cause: error, permanent: true });
    }
    try {
      await continueRemoteAgentSession({
        callback: {
          callId: action.callId,
          subagentName: identity.name,
          token: input.parentToken,
          url: createWorkflowCallbackUrl(
            address.callbackBaseUrl,
            createEveCallbackRoutePath(input.parentToken),
          ),
        },
        continuationToken: address.continuationToken,
        message: readSubagentMessage(action),
        outputSchema: normalizeRequestedOutputSchema(action.input.outputSchema),
        remote: { ...resolvedRemote, url: address.url },
        sessionId: address.sessionId,
      });
    } catch (error) {
      return err({
        cause: error,
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
        caller: {
          callId: action.callId,
          replyTo: { kind: "hook", token: input.parentToken },
          subagentName: identity.name,
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
        permanent: true,
      });
    }
  } catch (error) {
    return err({ cause: error, permanent: isRuntimeNoActiveSessionError(error) });
  }
  return ok(undefined);
}

function createAgentErrorResult(input: {
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
