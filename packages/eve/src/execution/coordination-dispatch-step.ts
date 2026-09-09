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
import { deliverTaskUpdate } from "#execution/tasks/child/update.js";
import { startWorkflowTask } from "#execution/tools/workflow/start.js";
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
    if (entry.kind === "workflow-task") {
      const started = await startWorkflowTask({
        auth: prepared.auth,
        batchEvent: batch.event,
        initiatorAuth: prepared.initiatorAuth,
        owner: input.workflowToolRunOwner,
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
  }

  return {
    results: [...results, ...normalized.results],
    sessionState:
      nextSession === session
        ? prepared.sessionState
        : createDurableSessionState({ session: nextSession }),
    pendingTasks,
  };
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
    usedCalls:
      pending.usedCalls + plan.allowed.filter((task) => task.resultKind === "subagent").length,
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
  readonly action: RuntimeWorkflowTaskRequest;
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

function getWorkflowTaskName(action: RuntimeWorkflowTaskRequest): string {
  return action.resultKind === "subagent" ? action.toolName : action.kind;
}
