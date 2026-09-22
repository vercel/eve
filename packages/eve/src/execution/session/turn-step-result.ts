import { createDurableSessionState } from "#execution/durable-session-store.js";
import { derivePendingState } from "#execution/session/pending-turn-state.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import {
  getBackgroundWorkflowToolRuns,
  readWorkflowTaskView,
} from "#harness/workflow-tool-runs.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";
import type { RunMode } from "#shared/run-mode.js";
import { preserveSerializedBackgroundTaskObservabilityState } from "#shared/serialized-observability-state.js";

export function resolveSessionStepResult(
  stepResult: StepResult,
  nextSerializedContext: Record<string, unknown>,
  mode: RunMode,
  beforeStepContext: Record<string, unknown>,
): DurableStepResult {
  const nextState = createDurableSessionState({ session: stepResult.session });
  if (stepResult.steered)
    return {
      action: "steered",
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  const backgroundTransition =
    stepResult.backgroundTasks === undefined || stepResult.backgroundTaskSession === undefined
      ? {}
      : {
          backgroundTaskContext: preserveSerializedBackgroundTaskObservabilityState(
            beforeStepContext,
            nextSerializedContext,
            stepResult.backgroundTasks,
          ),
          backgroundTaskState: createDurableSessionState({
            session: stepResult.backgroundTaskSession,
          }),
          backgroundTasks: stepResult.backgroundTasks,
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
    const pending = derivePendingState(stepResult.session);

    // Ending a model turn does not settle its caller while nested tasks remain open.
    // Leave usage unreported across yields so the final result includes every turn.
    if (stepResult.settledTurn !== undefined) {
      const hasPendingTasks = getBackgroundWorkflowToolRuns(stepResult.session.state).some(
        (run) => readWorkflowTaskView(run.task) === undefined,
      );
      if (hasPendingTasks && stepResult.settledTurn.isError !== true) {
        return {
          action: "park",
          ...backgroundTransition,
          ...pending,
          completion: { kind: "yielded" },
          serializedContext: nextSerializedContext,
          sessionState: nextState,
        };
      }
      const { delta, session: reportedSession } = takeSessionUsageDelta(stepResult.session);
      return {
        action: "park",
        ...backgroundTransition,
        ...pending,
        serializedContext: nextSerializedContext,
        sessionState: createDurableSessionState({ session: reportedSession }),
        completion: {
          kind: "settled",
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
