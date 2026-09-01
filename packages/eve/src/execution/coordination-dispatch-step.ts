/** Starts workflow-tool runs for pending blocking actions from either source. */

import { deserializeContext } from "#context/serialize.js";
import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import type { BackgroundTask } from "#execution/tasks/parent/delegate.js";
import { cancelBackgroundAgentTask } from "#execution/tools/subagent/task-cancel.js";
import { deliverTaskUpdate } from "#execution/task-update-delivery.js";
import { startWorkflowTask } from "#execution/tools/workflow/start.js";
import { startSubagent } from "#execution/tools/subagent/start.js";
import { dispatchToAgentAddress } from "#subagents/handle-dispatch.js";
import {
  confirmAgentStarted,
  prepareAgentContinuation,
  prepareAgentStart,
  rejectAgentEffect,
} from "#subagents/handles/transitions.js";
import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";
import { deriveAgentId } from "#subagents/handles/store.js";
import { mintSubagentContinuationToken } from "#execution/session.js";
import { createSubagentCalledEvent } from "#protocol/message.js";
import { emitTaskSubagentCalledStep } from "#execution/tools/subagent/emit-called-step.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createAgentContinuationBundle } from "#subagents/continuation-bundle.js";
import { createAgentErrorResult } from "#subagents/handle-dispatch.js";
import { AGENT_BUSY, AGENT_MISMATCH, AGENT_UNREACHABLE } from "#subagents/agent-handle-errors.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import {
  getPendingWorkflowInterrupt,
  setPendingWorkflowUsedCalls,
} from "#harness/workflow-interrupt-state.js";
import {
  planWorkflowSubagentDispatch,
  type WorkflowSubagentDispatchPlan,
} from "#harness/workflow-subagent-limit.js";
import { buildWorkflowTasksFromInterrupt } from "#harness/workflow-task-state.js";
import { createLogger } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeAgentDispatchRequest,
  RuntimeActionResult,
  RuntimeSubagentDispatchFailure,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";

const workflowTaskLog = createLogger("execution.dispatch-workflow-tasks");

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park" | "dispatch-workflow-tasks";
};

export async function dispatchCoordinationStep(
  input: CoordinationDispatchStepInput,
): Promise<CoordinationDispatchResult> {
  "use step";

  // Model-driven actions already have a coordination batch. Dynamic Workflow
  // tasks first need their interrupt lowered into that same representation.
  const normalized =
    input.action === "dispatch-workflow-tasks"
      ? await normalizeWorkflowTaskInterrupt(input)
      : { results: [], sessionState: input.sessionState };
  const prepared = await prepareCoordinationDispatch({
    serializedContext: input.serializedContext,
    sessionState: normalized.sessionState,
  });
  if (prepared === undefined) {
    return {
      results: normalized.results,
      sessionState: normalized.sessionState,
      pendingTasks: [],
    };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const pendingTasks: BackgroundTask[] = [];

  for (const entry of prepared.plan) {
    if (entry.kind === "reject") {
      results.push(entry.result);
      continue;
    }
    if (entry.kind === "workflow-task") {
      const started = await startWorkflowTask({
        auth: prepared.auth,
        batchEvent: batch.event,
        initiatorAuth: prepared.initiatorAuth,
        parentContinuationToken: input.parentContinuationToken ?? session.continuationToken,
        parentSession: prepared.parentSession,
        session: nextSession,
        task: entry.task,
      });
      nextSession = started.session;
      if (started.result !== undefined) results.push(started.result);
      continue;
    }
    if (entry.kind === "task-control") {
      const control = await executeTaskControlAction({
        action: entry.action,
        adapter: prepared.adapter,
        bundle: prepared.bundle,
        cancelOwnedWork: cancelBackgroundAgentTask,
        deliverUpdate: deliverTaskUpdate,
        parentStepIndex: batch.event.stepIndex,
        parentTurnId: batch.event.turnId,
        serializedContext: prepared.serializedContext,
        session: nextSession,
      });
      nextSession = control.session;
      if (control.pendingTask !== undefined) pendingTasks.push(control.pendingTask);
      results.push(control.result);
      continue;
    }
    const operationId = deriveAgentOperationId({
      callId: entry.kind === "resume" ? entry.action.callId : entry.target.action.callId,
      parentSessionId: nextSession.sessionId,
      parentTurnId: batch.event.turnId,
    });
    if (entry.kind === "resume") {
      const invokedName =
        entry.action.kind === "remote-agent-call"
          ? entry.action.remoteAgentName
          : entry.action.subagentName;
      const preparedContinuation = prepareAgentContinuation(nextSession, {
        agentId: entry.agentId,
        invokedName,
        operation: {
          callId: entry.action.callId,
          id: operationId,
          kind: "continue",
          parentTurnId: batch.event.turnId,
          previousStatus: "",
        },
      });
      if (preparedContinuation.kind !== "ready") {
        results.push(
          createAgentErrorResult({
            action: entry.action,
            code:
              preparedContinuation.kind === "mismatch"
                ? AGENT_MISMATCH
                : preparedContinuation.kind === "busy"
                  ? AGENT_BUSY
                  : AGENT_UNREACHABLE,
            message: `Agent "${invokedName}" could not be continued (${preparedContinuation.kind}).`,
          }),
        );
        continue;
      }
      nextSession = preparedContinuation.session;
      const outcome = await dispatchToAgentAddress({
        action: entry.action,
        auth: prepared.auth,
        bundle: createAgentContinuationBundle({
          action: entry.action,
          bundle: prepared.bundle,
          dynamicRemoteAgent: entry.dynamicRemoteAgent,
        }),
        currentSession: nextSession,
        parentToken: input.parentContinuationToken ?? session.continuationToken,
        handle: {
          address: preparedContinuation.handle.address,
          identity: preparedContinuation.handle.identity,
        },
      });
      nextSession = outcome.session;
      if (outcome.kind === "error") {
        nextSession = rejectAgentEffect(nextSession, {
          disposition: outcome.deliveryPermanent === true ? "dead" : "retryable",
          operationId,
        });
        results.push(outcome.result);
      } else {
        await emitBlockingSubagentCalled({
          action: entry.action,
          agentId: entry.agentId,
          outcome,
          prepared,
          writable: input.parentWritable,
        });
      }
      continue;
    }

    const action = entry.target.action;
    const name = action.kind === "remote-agent-call" ? action.remoteAgentName : action.subagentName;
    const identity = { id: deriveAgentId(name, operationId), name, nodeId: action.nodeId };
    nextSession = prepareAgentStart(nextSession, {
      identity,
      operation: {
        callId: action.callId,
        id: operationId,
        kind: "start",
        parentTurnId: batch.event.turnId,
      },
      target: resolveTurnStartTarget({
        callbackBaseUrl: input.callbackBaseUrl,
        entry,
        prepared,
      }),
    });
    const outcome = await startSubagent({
      auth: prepared.auth,
      batchEvent: batch.event,
      bundle: prepared.bundle,
      callbackBaseUrl: input.callbackBaseUrl,
      capabilities: prepared.capabilities,
      channelMetadata: prepared.channelMetadata,
      currentSession: nextSession,
      fanoutSize: prepared.fanoutSize,
      initiatorAuth: prepared.initiatorAuth,
      parentContinuationToken: input.parentContinuationToken,
      parentTraceContext: prepared.parentTraceContext,
      sandboxSessionId: prepared.sandboxSessionId,
      serializedContext: prepared.serializedContext,
      session: nextSession,
      target: entry.target,
    });
    nextSession = outcome.session;
    if (outcome.kind === "error") {
      nextSession = rejectAgentEffect(nextSession, { disposition: "dead", operationId });
      results.push(outcome.result);
    } else {
      nextSession = confirmAgentStarted(nextSession, { address: outcome.address, operationId });
      await emitBlockingSubagentCalled({
        action,
        agentId: identity.id,
        outcome,
        prepared,
        writable: input.parentWritable,
      });
    }
  }

  return {
    results: [...results, ...normalized.results],
    sessionState:
      nextSession === session
        ? normalized.sessionState
        : createDurableSessionState({ session: nextSession }),
    pendingTasks,
  };
}

function resolveTurnStartTarget(input: {
  readonly callbackBaseUrl?: string;
  readonly entry: Extract<
    import("#execution/coordination-dispatch-shared.js").DispatchPlanEntry,
    { kind: "start" }
  >;
  readonly prepared: import("#execution/coordination-dispatch-shared.js").PreparedCoordinationDispatch;
}): import("#subagents/handles/store.js").AgentStartTarget {
  const action = input.entry.target.action;
  if (input.entry.target.kind === "local") {
    return {
      continuationToken: mintSubagentContinuationToken(
        `${input.prepared.session.sessionId}:${action.callId}`,
      ),
      kind: input.entry.target.source.type === "runtime" ? "agent/self" : "agent/local",
    };
  }
  const callbackBaseUrl = input.callbackBaseUrl;
  if (callbackBaseUrl === undefined) {
    throw new Error("Cannot dispatch remote agent without a callback base URL.");
  }
  const registered = input.prepared.bundle.subagentRegistry.subagentsByNodeId.get(action.nodeId);
  const url =
    input.entry.target.dynamicRemoteAgent?.url ??
    (registered?.definition.kind === "remote" ? registered.definition.url : undefined);
  if (url === undefined) throw new Error(`Remote agent "${action.name}" has no URL.`);
  return { callbackBaseUrl, kind: "agent/remote", url };
}

async function emitBlockingSubagentCalled(input: {
  readonly action: RuntimeAgentDispatchRequest;
  readonly agentId: string;
  readonly outcome: Extract<
    import("#subagents/handle-dispatch.js").DispatchOutcome,
    { kind: "called" }
  >;
  readonly prepared: import("#execution/coordination-dispatch-shared.js").PreparedCoordinationDispatch;
  readonly writable: WritableStream<Uint8Array>;
}): Promise<void> {
  await emitTaskSubagentCalledStep({
    event: createSubagentCalledEvent({
      agentId: input.agentId,
      callId: input.outcome.callId,
      childSessionId: input.outcome.address.sessionId,
      name: input.outcome.name,
      remote:
        input.outcome.address.kind === "agent/remote"
          ? { url: input.outcome.address.url }
          : undefined,
      sequence: input.prepared.batch.event.sequence,
      sessionId: input.prepared.session.sessionId,
      toolName: input.outcome.toolName,
      turnId: input.prepared.batch.event.turnId,
      workflowId: workflowEntryReference.workflowId,
    }),
    parentWritable: input.writable,
    serializedContext: input.prepared.serializedContext,
  });
}

async function normalizeWorkflowTaskInterrupt(input: CoordinationDispatchInput): Promise<{
  readonly results: readonly RuntimeActionResult[];
  readonly sessionState: CoordinationDispatchInput["sessionState"];
}> {
  const durableSession = await readDurableSession(input.sessionState);
  const pending = getPendingWorkflowInterrupt(durableSession.state);
  if (pending === undefined) {
    return { results: [], sessionState: input.sessionState };
  }

  const tasks = buildWorkflowTasksFromInterrupt(pending.interrupt);
  if (tasks.length === 0) {
    return { results: [], sessionState: input.sessionState };
  }

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const plan = planWorkflowSubagentDispatch({
    tasks,
    maxSubagents: durableSession.workflowMaxSubagents,
    usedCalls: pending.usedCalls,
  });
  const blockedResults = plan.blocked.map((action) => {
    workflowTaskLog.warn("workflow subagent limit reached; blocking delegated call", {
      callId: action.callId,
      maxSubagents: plan.maxSubagents,
      subagentName: getWorkflowTaskName(action),
      usedCalls: plan.usedCalls,
    });
    return createWorkflowSubagentLimitResult({ action, plan });
  });

  if (plan.allowed.length === 0) {
    return { results: blockedResults, sessionState: input.sessionState };
  }

  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: effectiveAgent.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const sessionWithUsage = setPendingWorkflowUsedCalls({
    session,
    usedCalls: pending.usedCalls + plan.allowed.length,
  });
  const sessionWithBatch = setPendingCoordinationBatch({
    runtimeActions: [],
    tasks: plan.allowed,
    event: { sequence: 0, stepIndex: 0, turnId: "workflow-dispatch" },
    responseMessages: [],
    session: sessionWithUsage,
  });

  return {
    results: blockedResults,
    sessionState: createDurableSessionState({ session: sessionWithBatch }),
  };
}

function createWorkflowSubagentLimitResult(input: {
  readonly action: RuntimeAgentDispatchRequest | RuntimeWorkflowTaskRequest;
  readonly plan: WorkflowSubagentDispatchPlan;
}): RuntimeSubagentDispatchFailure {
  const subagentName = getWorkflowTaskName(input.action);

  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: "WORKFLOW_SUBAGENT_LIMIT_REACHED",
      maxSubagents: input.plan.maxSubagents,
      message: `Workflow subagent limit reached (${String(input.plan.maxSubagents)}); "${subagentName}" was not called.`,
    },
    subagentName,
  };
}

function getWorkflowTaskName(
  action: RuntimeAgentDispatchRequest | RuntimeWorkflowTaskRequest,
): string {
  return action.kind === "subagent-call"
    ? action.subagentName
    : action.kind === "remote-agent-call"
      ? action.remoteAgentName
      : action.resultKind === "subagent"
        ? action.toolName
        : action.kind;
}
