import { deserializeContext } from "#context/serialize.js";
import { dispatchCoordinationStep } from "#execution/coordination-dispatch-step.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  getPendingWorkflowInterrupt,
  setPendingWorkflowUsedCalls,
} from "#harness/workflow-interrupt-state.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import { buildWorkflowTasksFromInterrupt } from "#harness/workflow-task-state.js";
import {
  planWorkflowSubagentDispatch,
  type WorkflowSubagentDispatchPlan,
} from "#harness/workflow-subagent-limit.js";
import { getSubagentDelegationName, isSubagentDelegationAction } from "#harness/subagent-depth.js";
import { createLogger } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeSubagentDispatchFailure,
  RuntimeActionResult,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";

const log = createLogger("execution.dispatch-workflow-tasks");

/** Dispatches the child-agent tasks currently blocking a dynamic workflow. */
export async function dispatchWorkflowTasksStep(input: {
  readonly callbackBaseUrl?: string;
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly results: readonly RuntimeActionResult[];
  readonly sessionState: DurableSessionState;
  readonly pendingTasks: readonly {
    readonly taskInboxToken: string;
    readonly taskId: string;
    readonly taskRunId: string;
  }[];
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const pending = getPendingWorkflowInterrupt(durableSession.state);
  if (pending === undefined) {
    return { results: [], sessionState: input.sessionState, pendingTasks: [] };
  }

  const tasks = buildWorkflowTasksFromInterrupt(pending.interrupt);
  if (tasks.length === 0) {
    return { results: [], sessionState: input.sessionState, pendingTasks: [] };
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
    log.warn("workflow subagent limit reached; blocking delegated call", {
      callId: action.callId,
      maxSubagents: plan.maxSubagents,
      subagentName: isSubagentDelegationAction(action)
        ? getSubagentDelegationName(action)
        : action.kind,
      usedCalls: plan.usedCalls,
    });
    return createWorkflowSubagentLimitResult({ action, plan });
  });

  if (plan.allowed.length === 0) {
    return { results: blockedResults, sessionState: input.sessionState, pendingTasks: [] };
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

  const dispatched = await dispatchCoordinationStep({
    callbackBaseUrl: input.callbackBaseUrl,
    parentContinuationToken: input.parentContinuationToken,
    parentWritable: input.parentWritable,
    serializedContext: input.serializedContext,
    sessionState: createDurableSessionState({ session: sessionWithBatch }),
  });

  if (blockedResults.length === 0) {
    return dispatched;
  }

  return {
    results: [...dispatched.results, ...blockedResults],
    sessionState: dispatched.sessionState,
    pendingTasks: dispatched.pendingTasks,
  };
}

function createWorkflowSubagentLimitResult(input: {
  readonly action: RuntimeWorkflowTaskRequest;
  readonly plan: WorkflowSubagentDispatchPlan;
}): RuntimeSubagentDispatchFailure {
  const subagentName = isSubagentDelegationAction(input.action)
    ? getSubagentDelegationName(input.action)
    : input.action.kind;

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
