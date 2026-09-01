import {
  createAgentErrorResult,
  dispatchToTaskAgentAddress,
  type DispatchOutcome,
} from "#subagents/handle-dispatch.js";
import { createAgentContinuationBundle } from "#subagents/continuation-bundle.js";
import { startSubagent } from "#execution/coordination-dispatch-shared.js";
import { prepareOwnerAgentInvocation } from "#execution/tools/subagent/invocation-preparation.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { AgentInvocationRequest } from "#execution/tools/subagent/invocation.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";
import type { HandleEventFn } from "#harness/types.js";
import { createSubagentCalledEvent } from "#protocol/message.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";
import { createSubagentReceiptIdentity } from "#execution/tools/subagent/receipt-identity.js";
import {
  readAgentHandleStoreStep,
  sendAgentHandleCommandStep,
  type AgentHandleCommandResponse,
} from "#execution/session-command-inbox.js";
import type { TaskOwnedAgentHandle } from "#subagents/handles/store.js";
import { AGENT_BUSY, AGENT_MISMATCH, AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";

export interface AgentInvocationDispatchResult {
  readonly agentId?: string;
  readonly result?: RuntimeSubagentResult;
}

/** Dispatches one task-owned local or remote agent invocation. */
export async function dispatchAgentInvocation(input: {
  readonly callbackBaseUrl?: string;
  readonly emit?: HandleEventFn;
  readonly replyTo: string;
  readonly request: AgentInvocationRequest;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly taskId: string;
}): Promise<AgentInvocationDispatchResult> {
  const agentHandles = await readAgentHandleStoreStep({
    sessionId: input.sessionState.sessionId,
  });
  const prepared = await prepareOwnerAgentInvocation({
    invocation: input.request.input,
    invocationId: input.request.invocationId,
    knownAgentIds: agentHandles.handles.map((handle) => handle.identity.id),
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  const entry = prepared.plan[0];
  if (entry === undefined || entry.kind === "task-control" || entry.kind === "workflow-task") {
    throw new Error("Agent invocation produced no executable plan entry.");
  }
  if (entry.kind === "reject") return { result: entry.result };

  let outcome: DispatchOutcome;
  let agentId: string | undefined;
  if (entry.kind === "resume") {
    const operationId = deriveAgentOperationId({
      callId: entry.action.callId,
      parentSessionId: prepared.session.sessionId,
      parentTurnId: prepared.batch.event.turnId,
    });
    const claim = await sendAgentHandleCommandStep({
      command: {
        agentId: entry.agentId,
        expectedTarget: entry.action.kind === "remote-agent-call" ? "remote" : "local",
        invokedName:
          entry.action.kind === "remote-agent-call"
            ? entry.action.remoteAgentName
            : entry.action.subagentName,
        kind: "claim",
        operationId,
        taskId: input.taskId,
      },
      commandId: `${operationId}:claim`,
      sessionId: prepared.session.sessionId,
    });
    const claimed = readClaimedHandle(claim);
    if (claimed === undefined) {
      return { result: createTaskClaimError(entry.action, entry.agentId, claim) };
    }
    const bundle = createAgentContinuationBundle({
      action: entry.action,
      bundle: prepared.bundle,
      dynamicRemoteAgent: entry.dynamicRemoteAgent,
    });
    outcome = await dispatchToTaskAgentAddress({
      action: entry.action,
      auth: prepared.auth,
      bundle,
      currentSession: prepared.session,
      parentToken: input.replyTo,
      handle: claimed,
      taskId: input.taskId,
    });
    if (outcome.kind === "error" && outcome.deliveryPermanent === true) {
      await sendAgentHandleCommandStep({
        command: { agentId: entry.agentId, kind: "remove", taskId: input.taskId },
        commandId: `${operationId}:remove`,
        sessionId: prepared.session.sessionId,
      });
    }
    agentId = claimed.identity.id;
  } else {
    const action = entry.target.action;
    const start = createSubagentReceiptIdentity({
      callId: action.callId,
      subagentName:
        action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName,
      nodeId: action.nodeId,
      parentSessionId: prepared.session.sessionId,
      parentTurnId: prepared.batch.event.turnId,
    });
    const reservation = await sendAgentHandleCommandStep({
      command: {
        identity: start.identity,
        kind: "reserve",
        operationId: start.operation.id,
        taskId: input.taskId,
      },
      commandId: `${start.operation.id}:reserve`,
      sessionId: prepared.session.sessionId,
    });
    if (reservation.result.kind !== "ready") {
      throw new Error(`Agent handle store rejected start operation "${start.operation.id}".`);
    }
    outcome = await startSubagent({
      auth: prepared.auth,
      batchEvent: prepared.batch.event,
      bundle: prepared.bundle,
      callbackBaseUrl: input.callbackBaseUrl,
      capabilities: prepared.capabilities,
      channelMetadata: prepared.channelMetadata,
      currentSession: prepared.session,
      fanoutSize: prepared.fanoutSize,
      initiatorAuth: prepared.initiatorAuth,
      parentContinuationToken: input.replyTo,
      parentTraceContext: prepared.parentTraceContext,
      sandboxSessionId: prepared.sandboxSessionId,
      serializedContext: prepared.serializedContext,
      session: prepared.session,
      taskId: input.taskId,
      target: entry.target,
    });
    agentId = start.identity.id;
    if (outcome.kind === "error") {
      await sendAgentHandleCommandStep({
        command: { agentId, kind: "remove", taskId: input.taskId },
        commandId: `${start.operation.id}:remove`,
        sessionId: prepared.session.sessionId,
      });
    } else {
      const confirmed = await sendAgentHandleCommandStep({
        command: {
          address: outcome.address,
          kind: "confirm",
          operationId: start.operation.id,
          taskId: input.taskId,
        },
        commandId: `${start.operation.id}:confirm`,
        sessionId: prepared.session.sessionId,
      });
      if (readClaimedHandle(confirmed) === undefined) {
        throw new Error(
          `Agent handle store could not confirm start operation "${start.operation.id}".`,
        );
      }
    }
  }

  if (outcome.kind === "error") return { result: outcome.result };

  const action = entry.kind === "resume" ? entry.action : entry.target.action;
  const dynamicRemoteAgent =
    entry.kind === "resume"
      ? entry.dynamicRemoteAgent
      : entry.target.kind === "remote"
        ? entry.target.dynamicRemoteAgent
        : undefined;
  if (input.emit !== undefined) {
    await input.emit(
      createSubagentCalledEvent({
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
      }),
    );
  }
  return { agentId };
}

/** Dispatches one task-owned agent request after the task is acknowledged. */
export async function dispatchTaskAgentInvocationStep(
  input: Omit<Parameters<typeof dispatchAgentInvocation>[0], "emit">,
): Promise<AgentInvocationDispatchResult> {
  "use step";

  return await dispatchAgentInvocation(input);
}

function readClaimedHandle(
  event: AgentHandleCommandResponse,
): Extract<TaskOwnedAgentHandle, { phase: "claimed" }> | undefined {
  const handle = event.result.kind === "ready" ? event.result.handle : undefined;
  return handle?.phase === "claimed" ? handle : undefined;
}

function createTaskClaimError(
  action: Parameters<typeof createAgentErrorResult>[0]["action"],
  agentId: string,
  event: AgentHandleCommandResponse,
): RuntimeSubagentResult {
  const result = event.result;
  if (result.kind === "mismatch") {
    return createAgentErrorResult({
      action,
      code: AGENT_MISMATCH,
      message: `Agent "${agentId}" no longer matches this subagent definition. Start a new agent instead.`,
    });
  }
  if (result.kind === "busy") {
    const taskId = "taskId" in result.handle ? result.handle.taskId : undefined;
    return createAgentErrorResult({
      action,
      code: AGENT_BUSY,
      message:
        taskId === undefined
          ? `Agent "${result.handle.identity.name}" with id "${agentId}" is still working on another task.`
          : `Agent "${result.handle.identity.name}" with id "${agentId}" is still working on task "${taskId}".`,
    });
  }
  return createAgentErrorResult({
    action,
    code: AGENT_UNREACHABLE,
    message: `Agent with id "${agentId}" is no longer reachable.`,
  });
}
