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
import { AGENT_BUSY, AGENT_MISMATCH, AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";
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

export type AgentInvocationDispatchResult =
  | {
      readonly kind: "dispatched";
      readonly agentId: string;
      readonly event: SubagentCalledStreamEvent;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "failed";
      readonly result: RuntimeSubagentResult;
      readonly sessionState: DurableSessionState;
    };

export type TaskAgentInvocationDispatchResult =
  | { readonly kind: "not-admitted"; readonly sessionState: DurableSessionState }
  | AgentInvocationDispatchResult;

/** Dispatches one owner-scoped local or remote agent invocation. */
export async function dispatchAgentInvocation(input: {
  readonly callbackBaseUrl?: string;
  readonly emit?: HandleEventFn;
  readonly replyTo: string;
  readonly request: AgentInvocationRequest;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly ownerId: string;
  readonly taskId?: string;
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
    return { kind: "failed", result: entry.result, sessionState: sessionState() };
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
        return {
          kind: "failed",
          result: createTaskClaimError(entry.action, entry.agentId, claim),
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
      serializedContext: prepared.serializedContext,
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

  if (outcome.kind === "error") {
    return { kind: "failed", result: outcome.result, sessionState: sessionState() };
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
  return { kind: "dispatched", agentId, event, sessionState: sessionState() };
}

/** Dispatches one agent request after any task-owned invocation is admitted. */
export async function dispatchTaskAgentInvocationStep(
  input: Omit<Parameters<typeof dispatchAgentInvocation>[0], "emit">,
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
  return await dispatchAgentInvocation(input);
}

/** Applies an owner-scoped child settlement to the parent session's canonical state. */
export async function settleTaskAgentInvocationStep(input: {
  readonly accumulateUsage?: boolean;
  readonly ownerId: string;
  readonly result: RuntimeSubagentChildResult;
  readonly sessionState: DurableSessionState;
  readonly taskId?: string;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const durable = await readDurableSession(input.sessionState);
  const handles = getAgentHandleStore(durable.state)?.handles ?? [];
  const candidates = handles.filter(
    (candidate) => candidate.phase === "claimed" && candidate.ownerId === input.ownerId,
  );
  const handle =
    candidates.find(
      (candidate) => candidate.phase === "claimed" && candidate.callId === input.result.callId,
    ) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (handle?.phase !== "claimed") return { sessionState: input.sessionState };

  const nextHandles =
    input.result.outcome.kind === "terminal"
      ? handles.filter((candidate) => candidate !== handle)
      : handles.map((candidate) =>
          candidate === handle
            ? {
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
    sessionState: replaceDurableSessionSnapshot({ session, state: input.sessionState }),
  };
}

/** Releases any child leases still owned by a completed workflow-tool run. */
export async function releaseAgentInvocationOwnerStep(input: {
  readonly ownerId: string;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly sessionState: DurableSessionState }> {
  "use step";

  const durable = await readDurableSession(input.sessionState);
  const session = applyTaskAgentHandleCommand(durable, {
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
    const owned = "ownerId" in result.handle;
    return createAgentErrorResult({
      action,
      code: AGENT_BUSY,
      message: !owned
        ? `Agent "${result.handle.identity.name}" with id "${agentId}" is still working on another task.`
        : `Agent "${result.handle.identity.name}" with id "${agentId}" is still working on another invocation.`,
    });
  }
  return createAgentErrorResult({
    action,
    code: AGENT_UNREACHABLE,
    message: `Agent with id "${agentId}" is no longer reachable.`,
  });
}
