import { deserializeContext } from "#context/serialize.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { hydrateDurableSession } from "#execution/session.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import { setPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { buildRuntimeActionsFromWorkflowInterrupt } from "#harness/workflow-runtime-action-state.js";
import {
  planWorkflowSubagentDispatch,
  type WorkflowSubagentDispatchPlan,
} from "#harness/workflow-subagent-limit.js";
import { getSubagentDelegationName, isSubagentDelegationAction } from "#harness/subagent-depth.js";
import { createLogger } from "#internal/logging.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type {
  RuntimeActionRequest,
  RuntimeSubagentResultActionResult,
} from "#runtime/actions/types.js";

const log = createLogger("execution.dispatch-workflow-runtime-actions");

/** Dispatches the child-agent action currently blocking a dynamic workflow. */
export async function dispatchWorkflowRuntimeActionsStep(input: {
  readonly callbackBaseUrl?: string;
  readonly parentContinuationToken?: string;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{
  readonly results: readonly RuntimeSubagentResultActionResult[];
  readonly sessionState: DurableSessionState;
}> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const pending = getPendingWorkflowInterrupt(durableSession.state);
  if (pending === undefined) return { results: [], sessionState: input.sessionState };

  const actions = buildRuntimeActionsFromWorkflowInterrupt(pending.interrupt);
  if (actions.length === 0) return { results: [], sessionState: input.sessionState };

  const ctx = await deserializeContext(input.serializedContext);
  const bundle = ctx.require(BundleKey);

  const plan = planWorkflowSubagentDispatch({
    actions,
    interrupt: pending.interrupt,
    maxSubagents: durableSession.workflowMaxSubagents,
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
    return { results: blockedResults, sessionState: input.sessionState };
  }

  const session = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });

  const sessionWithBatch = setPendingRuntimeActionBatch({
    actions: plan.allowed,
    event: { sequence: 0, stepIndex: 0, turnId: "workflow-dispatch" },
    responseMessages: [],
    session,
  });

  const dispatched = await dispatchRuntimeActionsStep({
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
  };
}

function createWorkflowSubagentLimitResult(input: {
  readonly action: RuntimeActionRequest;
  readonly plan: WorkflowSubagentDispatchPlan;
}): RuntimeSubagentResultActionResult {
  const subagentName = isSubagentDelegationAction(input.action)
    ? getSubagentDelegationName(input.action)
    : input.action.kind;

  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: "WORKFLOW_SUBAGENT_LIMIT_REACHED",
      maxSubagents: input.plan.maxSubagents,
      message: `Workflow subagent limit reached (${String(input.plan.maxSubagents)}); "${subagentName}" was not called.`,
    },
    subagentName,
  };
}
