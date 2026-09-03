import {
  createAgentErrorResult,
  dispatchToClaimedAgentAddress,
  type DispatchOutcome,
} from "#subagents/handle-dispatch.js";
import { createAgentContinuationBundle } from "#subagents/continuation-bundle.js";
import { startSubagent } from "#execution/tools/subagent/start.js";
import { prepareOwnerAgentInvocation } from "#execution/tools/subagent/invoke-preparation.js";
import type { AgentInvocationRequest } from "#execution/tools/subagent/invoke-agent.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import type { HandleEventFn } from "#harness/types.js";
import { createSubagentCalledEvent, type SubagentCalledStreamEvent } from "#protocol/message.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";
import { createSubagentReceiptIdentity } from "#execution/tools/subagent/receipt-identity.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { projectToDurableSession } from "#execution/session.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import {
  getAgentHandleStore,
  writeHandles,
  type AgentHandle,
  type AgentHandleStoreCommand,
  type AgentHandleStoreCommandResult,
  type TaskOwnedAgentHandle,
} from "#subagents/handles/store.js";
import { applyTaskAgentHandleCommand } from "#subagents/handles/transitions.js";
import { abandonAgentInvocationOwners } from "#subagents/handles/transitions.js";
import {
  AGENT_BUSY,
  AGENT_MISMATCH,
  AGENT_UNREACHABLE,
  formatAgentBusyMessage,
} from "#subagents/agent-handle-errors.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";
import { isTerminalTaskStatus } from "#tasks/types.js";
import type { RuntimeSubagentChildResult } from "#shared/action-types.js";
import {
  clearProxyInputRequestsForChild,
  clearProxyInputRequestsForTask,
} from "#harness/proxy-input-requests.js";
import {
  accumulateSessionUsage,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import {
  recordActionChildTraceId,
  recordActionInvocationKind,
  recordNestedAgentInvocation,
  recordNestedAgentInvocationTerminal,
} from "#tracing/agent-trace-context-store.js";
import { deriveAgentActionSpanId } from "#tracing/agent-span-id-generator.js";

export type AgentInvocationDispatchResult =
  | {
      readonly kind: "dispatched";
      readonly agentId: string;
      readonly event: SubagentCalledStreamEvent;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "failed";
      readonly result: RuntimeSubagentResult;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

export type TaskAgentInvocationDispatchResult =
  | { readonly kind: "not-admitted"; readonly sessionState: DurableSessionState }
  | AgentInvocationDispatchResult;

/** Dispatches one owner-scoped local or remote agent invocation. */
export async function dispatchAgentInvocation(input: {
  readonly actionCallId?: string;
  readonly callbackBaseUrl: string;
  readonly emit?: HandleEventFn;
  readonly replyTo: string;
  readonly request: AgentInvocationRequest;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly ownerId: string;
  readonly taskId?: string | undefined;
}): Promise<AgentInvocationDispatchResult> {
  const durableSession = await readDurableSession(input.sessionState);
  const agentHandles = getAgentHandleStore(durableSession.state)?.handles ?? [];
  const prepared = await prepareOwnerAgentInvocation({
    invocation: input.request.input,
    invocationId: input.request.invocationId,
    knownAgentIds: agentHandles.map((handle) => handle.identity.id),
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  const entry = prepared.plan[0];
  if (entry === undefined) {
    throw new Error("Agent invocation produced no executable plan entry.");
  }
  const invocationAction = entry.kind === "start" ? entry.target.action : entry.action;
  const outerActionCallId = input.actionCallId ?? invocationAction.callId;
  const nestedInvocation = outerActionCallId !== invocationAction.callId;
  const actionCallId = nestedInvocation ? invocationAction.callId : outerActionCallId;
  let serializedContext = nestedInvocation
    ? recordNestedAgentInvocation({
        callId: invocationAction.callId,
        kind: invocationAction.kind,
        name: invocationAction.name,
        outerCallId: outerActionCallId,
        serializedContext: prepared.serializedContext,
        sessionId: prepared.session.sessionId,
        spanId: deriveAgentActionSpanId(
          prepared.session.sessionId,
          prepared.batch.event.turnId,
          invocationAction.callId,
        ),
        turnId: prepared.batch.event.turnId,
      })
    : recordActionInvocationKind(
        prepared.serializedContext,
        prepared.session.sessionId,
        prepared.batch.event.turnId,
        actionCallId,
        invocationAction.kind,
      );
  let session = prepared.session;
  const currentAgentHandles = (): readonly AgentHandle[] =>
    getAgentHandleStore(session.state)?.handles ?? [];
  const sessionState = (): DurableSessionState =>
    replaceDurableSessionSnapshot({
      session: projectToDurableSession(session),
      state: input.sessionState,
    });
  const applyHandleCommand = (command: AgentHandleStoreCommand): AgentHandleStoreCommandResult => {
    const applied = applyTaskAgentHandleCommand(session, command);
    session = applied.session;
    return applied.result;
  };
  if (entry.kind === "reject") {
    serializedContext = recordInvocationFailure(
      serializedContext,
      prepared.session.sessionId,
      prepared.batch.event.turnId,
      invocationAction.callId,
      entry.result,
    );
    return {
      kind: "failed",
      result: entry.result,
      serializedContext,
      sessionState: sessionState(),
    };
  }

  let outcome: DispatchOutcome;
  let agentId: string;
  if (entry.kind === "resume") {
    const existingClaims = currentAgentHandles().filter(
      (handle): handle is Extract<TaskOwnedAgentHandle, { readonly phase: "claimed" }> =>
        handle.phase === "claimed" &&
        handle.ownerId === input.ownerId &&
        handle.callId === entry.action.callId &&
        handle.identity.id === entry.agentId,
    );
    if (existingClaims.length > 1) {
      throw new Error(
        `Invocation owner "${input.ownerId}" has multiple claims for "${entry.action.callId}".`,
      );
    }
    let claimed = existingClaims[0];
    if (claimed === undefined) {
      const operationId = deriveAgentOperationId({
        callId: entry.action.callId,
        parentSessionId: prepared.session.sessionId,
        parentTurnId: prepared.batch.event.turnId,
      });
      const claim = applyHandleCommand({
        agentId: entry.agentId,
        callId: entry.action.callId,
        expectedTarget: entry.action.kind === "remote-agent-call" ? "remote" : "local",
        invokedName:
          entry.action.kind === "remote-agent-call"
            ? entry.action.remoteAgentName
            : entry.action.subagentName,
        kind: "claim",
        operationId,
        ownerId: input.ownerId,
      });
      claimed = readClaimedHandle(claim);
      if (claimed === undefined) {
        const result = createTaskClaimError(entry.action, entry.agentId, claim);
        serializedContext = recordInvocationFailure(
          serializedContext,
          prepared.session.sessionId,
          prepared.batch.event.turnId,
          invocationAction.callId,
          result,
        );
        return {
          kind: "failed",
          result,
          serializedContext,
          sessionState: sessionState(),
        };
      }
    }
    const bundle = createAgentContinuationBundle({
      action: entry.action,
      bundle: prepared.bundle,
      dynamicRemoteAgent: entry.dynamicRemoteAgent,
    });
    outcome = await dispatchToClaimedAgentAddress({
      action: entry.action,
      auth: prepared.auth,
      bundle,
      currentSession: session,
      parentToken: input.replyTo,
      handle: claimed,
      taskId: input.taskId,
    });
    if (outcome.kind === "error" && outcome.deliveryPermanent === true) {
      applyHandleCommand({ agentId: entry.agentId, kind: "remove", ownerId: input.ownerId });
    }
    agentId = claimed.identity.id;
  } else {
    const action = entry.target.action;
    const reserved = currentAgentHandles().filter(
      (handle): handle is Extract<TaskOwnedAgentHandle, { readonly phase: "reserved" }> =>
        handle.phase === "reserved" &&
        handle.ownerId === input.ownerId &&
        handle.callId === action.callId &&
        handle.identity.name === action.name &&
        handle.identity.nodeId === action.nodeId,
    );
    const start =
      reserved.length === 1
        ? { identity: reserved[0]!.identity, operation: { id: reserved[0]!.operationId } }
        : createSubagentReceiptIdentity({
            callId: action.callId,
            subagentName:
              action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName,
            nodeId: action.nodeId,
            parentSessionId: prepared.session.sessionId,
            parentTurnId: prepared.batch.event.turnId,
          });
    if (reserved.length > 1) {
      throw new Error(
        `Invocation owner "${input.ownerId}" has multiple reservations for "${action.callId}".`,
      );
    }
    if (reserved.length === 0) {
      const reservation = applyHandleCommand({
        identity: start.identity,
        callId: action.callId,
        kind: "reserve",
        operationId: start.operation.id,
        ownerId: input.ownerId,
      });
      if (reservation.kind !== "ready") {
        throw new Error(`Agent handle store rejected start operation "${start.operation.id}".`);
      }
    }
    outcome = await startSubagent({
      instrumentationCallId: actionCallId,
      auth: prepared.auth,
      batchEvent: prepared.batch.event,
      bundle: prepared.bundle,
      callbackBaseUrl: input.callbackBaseUrl,
      capabilities: prepared.capabilities,
      channelMetadata: prepared.channelMetadata,
      currentSession: session,
      fanoutSize: prepared.fanoutSize,
      initiatorAuth: prepared.initiatorAuth,
      localDevRequest: prepared.localDevRequest,
      parentContinuationToken: input.replyTo,
      parentTraceContext: prepared.parentTraceContext,
      sandboxSessionId: prepared.sandboxSessionId,
      serializedContext,
      session,
      taskId: input.taskId,
      target: entry.target,
    });
    agentId = start.identity.id;
    if (outcome.kind === "error") {
      applyHandleCommand({ agentId, kind: "remove", ownerId: input.ownerId });
    } else {
      const confirmed = applyHandleCommand({
        address: outcome.address,
        kind: "confirm",
        operationId: start.operation.id,
        ownerId: input.ownerId,
      });
      if (readClaimedHandle(confirmed) === undefined) {
        throw new Error(
          `Agent handle store could not confirm start operation "${start.operation.id}".`,
        );
      }
    }
  }

  const confirmedChildTraceId =
    outcome.kind === "called" ? outcome.address.traceId : outcome.childTraceId;
  if (confirmedChildTraceId !== undefined) {
    serializedContext = recordActionChildTraceId(
      serializedContext,
      prepared.session.sessionId,
      prepared.batch.event.turnId,
      actionCallId,
      confirmedChildTraceId,
    );
  }

  if (outcome.kind === "error") {
    serializedContext = recordInvocationFailure(
      serializedContext,
      prepared.session.sessionId,
      prepared.batch.event.turnId,
      invocationAction.callId,
      outcome.result,
    );
    return {
      kind: "failed",
      result: outcome.result,
      serializedContext,
      sessionState: sessionState(),
    };
  }

  const action = entry.kind === "resume" ? entry.action : entry.target.action;
  const dynamicRemoteAgent =
    entry.kind === "resume"
      ? entry.dynamicRemoteAgent
      : entry.target.kind === "remote"
        ? entry.target.dynamicRemoteAgent
        : undefined;
  const event = createSubagentCalledEvent({
    agentId,
    callId: outcome.callId,
    childSessionId: outcome.address.sessionId,
    name: outcome.name,
    remote:
      outcome.address.kind === "agent/remote"
        ? {
            resolverId:
              dynamicRemoteAgent === undefined
                ? action.nodeId
                : dynamicRemoteAgent.credentialsStepId,
            url: outcome.address.url,
          }
        : undefined,
    sequence: prepared.batch.event.sequence,
    sessionId: prepared.session.sessionId,
    toolName: outcome.toolName,
    turnId: prepared.batch.event.turnId,
    workflowId: workflowEntryReference.workflowId,
  });
  if (input.emit !== undefined) {
    await input.emit(event);
  }
  return {
    kind: "dispatched",
    agentId,
    event,
    serializedContext,
    sessionState: sessionState(),
  };
}

/**
 * Dispatches one agent request after any task-owned invocation is admitted.
 * The callback origin is parent-owned, so it is derived from this workflow's
 * own metadata rather than accepted from the inbound request.
 */
export async function dispatchTaskAgentInvocationStep(
  input: Omit<Parameters<typeof dispatchAgentInvocation>[0], "callbackBaseUrl" | "emit">,
): Promise<TaskAgentInvocationDispatchResult> {
  "use step";

  if (input.taskId !== undefined) {
    const session = await readDurableSession(input.sessionState);
    const entry = findSessionTaskEntry(session.state, input.taskId);
    if (entry === undefined) return { kind: "not-admitted", sessionState: input.sessionState };
    const view = await readLatestTaskView({ taskRunId: entry.taskRunId });
    if (view === undefined || isTerminalTaskStatus(view.status)) {
      return { kind: "not-admitted", sessionState: input.sessionState };
    }
  }
  return await dispatchAgentInvocation({
    ...input,
    callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
  });
}

/** Applies an owner-scoped child settlement to the parent session's canonical state. */
export async function settleTaskAgentInvocationStep(input: {
  readonly accumulateUsage?: boolean;
  readonly ownerId: string;
  readonly result: RuntimeSubagentChildResult;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly taskId?: string | undefined;
}): Promise<{
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durable = await readDurableSession(input.sessionState);
  const serializedContext = recordNestedAgentInvocationTerminal({
    callId: input.result.callId,
    serializedContext: input.serializedContext,
    sessionId: durable.sessionId,
    terminal: childInvocationTerminal(input.result),
  });
  const handles = getAgentHandleStore(durable.state)?.handles ?? [];
  const candidates = handles.filter(
    (candidate) => candidate.phase === "claimed" && candidate.ownerId === input.ownerId,
  );
  const handle =
    candidates.find(
      (candidate) => candidate.phase === "claimed" && candidate.callId === input.result.callId,
    ) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (handle?.phase !== "claimed") {
    return { serializedContext, sessionState: input.sessionState };
  }

  const nextHandles =
    input.result.outcome.kind === "terminal"
      ? handles.filter((candidate) => candidate !== handle)
      : handles.map((candidate) =>
          candidate === handle
            ? input.result.outcome.result.kind === "cancelled"
              ? {
                  address: handle.address,
                  identity: handle.identity,
                  lastStatus: "(cancelled)",
                  phase: "parked" as const,
                }
              : {
                  address: handle.address,
                  identity: handle.identity,
                  phase: "available" as const,
                }
            : candidate,
        );
  let session = writeHandles(durable, nextHandles);
  if (input.result.outcome.kind === "terminal") {
    session =
      input.taskId === undefined
        ? "continuationToken" in handle.address
          ? clearProxyInputRequestsForChild(
              session as Parameters<typeof clearProxyInputRequestsForChild>[0],
              handle.address.continuationToken,
            )
          : session
        : clearProxyInputRequestsForTask(session, input.taskId);
  }
  if (input.accumulateUsage !== false) {
    session = setTurnUsageState(
      session,
      accumulateSessionUsage({
        previous: getTurnUsageState(session.state),
        usage: input.result.outcome.usageDelta,
      }),
    );
  }
  return {
    serializedContext,
    sessionState: replaceDurableSessionSnapshot({ session, state: input.sessionState }),
  };
}

/** Releases any child leases still owned by a completed workflow-tool run. */
export async function releaseAgentInvocationOwnerStep(input: {
  readonly cancelled?: boolean;
  readonly ownerId: string;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const durable = await readDurableSession(input.sessionState);
  const session = input.cancelled
    ? abandonAgentInvocationOwners(durable, new Set([input.ownerId]))
    : applyTaskAgentHandleCommand(durable, {
        kind: "release-owner",
        ownerId: input.ownerId,
      }).session;
  return {
    sessionState:
      session === durable
        ? input.sessionState
        : replaceDurableSessionSnapshot({ session, state: input.sessionState }),
  };
}

function readClaimedHandle(
  result: AgentHandleStoreCommandResult,
): Extract<TaskOwnedAgentHandle, { phase: "claimed" }> | undefined {
  const handle = result.kind === "ready" ? result.handle : undefined;
  return handle?.phase === "claimed" ? handle : undefined;
}

function recordInvocationFailure(
  serializedContext: Record<string, unknown>,
  sessionId: string,
  turnId: string,
  callId: string,
  result: RuntimeSubagentResult,
): Record<string, unknown> {
  return recordNestedAgentInvocationTerminal({
    callId,
    serializedContext,
    sessionId,
    terminal: {
      acceptedAtMs: Date.now(),
      error: invocationError(result.output),
      outcome: "failed",
    },
    turnId,
  });
}

function childInvocationTerminal(
  result: RuntimeSubagentChildResult,
): Parameters<typeof recordNestedAgentInvocationTerminal>[0]["terminal"] {
  const turnResult = result.outcome.result;
  const usage = result.usage ?? result.outcome.usageDelta;
  return {
    acceptedAtMs: Date.now(),
    error: turnResult.kind === "failed" ? invocationError(turnResult.error) : undefined,
    outcome:
      turnResult.kind === "succeeded"
        ? "completed"
        : turnResult.kind === "cancelled"
          ? "cancelled"
          : "failed",
    usage: {
      inputTokenDetails: {
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  };
}

function invocationError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    return new Error(String(value.message));
  }
  return new Error(typeof value === "string" ? value : "Agent invocation failed.");
}
function createTaskClaimError(
  action: Parameters<typeof createAgentErrorResult>[0]["action"],
  agentId: string,
  result: AgentHandleStoreCommandResult,
): RuntimeSubagentResult {
  if (result.kind === "mismatch") {
    return createAgentErrorResult({
      action,
      code: AGENT_MISMATCH,
      message: `Agent "${agentId}" no longer matches this subagent definition. Start a new agent instead.`,
    });
  }
  if (result.kind === "busy") {
    return createAgentErrorResult({
      action,
      code: AGENT_BUSY,
      message: formatAgentBusyMessage({
        agentId,
        agentName: result.handle.identity.name,
        ownerId: "ownerId" in result.handle ? result.handle.ownerId : undefined,
      }),
    });
  }
  return createAgentErrorResult({
    action,
    code: AGENT_UNREACHABLE,
    message: `Agent with id "${agentId}" is no longer reachable.`,
  });
}
