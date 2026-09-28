import { createDurableSessionState } from "#execution/durable-session-store.js";
import { derivePendingState } from "#execution/session/pending-turn-state.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { getBackgroundTasks } from "#harness/workflow-tool-runs.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";
import { preserveSerializedBackgroundTaskObservabilityState } from "#shared/serialized-observability-state.js";

export function resolveSessionStepResult(
  stepResult: StepResult,
  nextSerializedContext: Record<string, unknown>,
  beforeStepContext: Record<string, unknown>,
  /** The turn this step belongs to. */
  turnId: string,
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

    // A turn that ends while its own background tasks are working yields: its answer is interim.
    // Usage stays unreported so the caller's final result includes every yielded turn. An error
    // is final and always answers the caller.
    if (stepResult.settledTurn !== undefined) {
      const yielded =
        stepResult.settledTurn.isError !== true &&
        getBackgroundTasks(stepResult.session.state).query({ state: "working", turnId }).length > 0;
      if (yielded) {
        return {
          action: "park",
          ...backgroundTransition,
          ...pending,
          settled: { ...stepResult.settledTurn, notifyCaller: false },
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
        settled: {
          notifyCaller: true,
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
