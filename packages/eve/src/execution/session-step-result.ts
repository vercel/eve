import { createDurableSessionState } from "#execution/durable-session-store.js";
import { derivePendingState } from "#execution/pending-turn-state.js";
import type { DurableStepResult } from "#execution/turn-step.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import { getWorkflowTaskCallIds, isWorkflowTaskInterrupt } from "#harness/workflow-task-state.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { HarnessSettlement, StepResult } from "#harness/types.js";
import type { RunMode } from "#shared/run-mode.js";

export function resolveSessionStepResult(
  stepResult: StepResult,
  nextSerializedContext: Record<string, unknown>,
  mode: RunMode,
  settlement: HarnessSettlement | undefined,
): DurableStepResult {
  const nextState = createDurableSessionState({ session: stepResult.session });
  const backgroundTransition = {
    settlement,
    ...(stepResult.backgroundTasks === undefined || stepResult.backgroundTaskSession === undefined
      ? {}
      : {
          backgroundTaskState: createDurableSessionState({
            session: stepResult.backgroundTaskSession,
          }),
          backgroundTasks: stepResult.backgroundTasks,
        }),
  };

  if (
    stepResult.next !== null &&
    typeof stepResult.next === "object" &&
    "done" in stepResult.next
  ) {
    if (mode === "task" && hasPendingInputBatch(stepResult.session.state)) {
      throw new Error("Task mode cannot complete while input requests remain pending.");
    }
    const sessionTotals = getTurnUsageState(stepResult.session.state)?.session;
    return {
      action: "done",
      ...backgroundTransition,
      output: stepResult.next.output,
      isError: stepResult.next.isError,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
      usage: sessionTotals === undefined ? undefined : toUsage(sessionTotals),
      usageDelta: takeSessionUsageDelta(stepResult.session).delta,
    };
  }

  if (stepResult.next === null) {
    const workflowInterrupt = getPendingWorkflowInterrupt(stepResult.session.state);
    if (workflowInterrupt !== undefined && isWorkflowTaskInterrupt(workflowInterrupt.interrupt)) {
      return {
        action: "dispatch-workflow-tasks",
        ...backgroundTransition,
        pendingTaskCallIds: getWorkflowTaskCallIds(workflowInterrupt.interrupt),
        serializedContext: nextSerializedContext,
        sessionState: nextState,
      };
    }

    const pending = derivePendingState(stepResult.session);

    // `settledTurn` is the harness's explicit settlement verdict. Pending
    // state may predate this turn, while newly created parks omit the verdict.
    // Usage is only proposed here; committing settlement marks it reported.
    if (stepResult.settledTurn !== undefined) {
      const { delta } = takeSessionUsageDelta(stepResult.session);
      return {
        action: "park",
        ...backgroundTransition,
        ...pending,
        serializedContext: nextSerializedContext,
        sessionState: nextState,
        settled: {
          output: stepResult.settledTurn.output,
          isError: stepResult.settledTurn.isError,
          usage: delta,
        },
      };
    }

    return {
      action: "park",
      ...backgroundTransition,
      ...pending,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  return {
    action: "continue",
    ...backgroundTransition,
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}
