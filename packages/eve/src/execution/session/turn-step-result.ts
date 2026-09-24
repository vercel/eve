import { createDurableSessionState } from "#execution/durable-session-store.js";
import { derivePendingState } from "#execution/session/pending-turn-state.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";
import type { RunMode } from "#shared/run-mode.js";
import { hasPendingBackgroundWork } from "#tasks/results.js";

export function resolveSessionStepResult(
  stepResult: StepResult,
  nextSerializedContext: Record<string, unknown>,
  mode: RunMode,
): DurableStepResult {
  const nextState = createDurableSessionState({ session: stepResult.session });
  if (stepResult.steered)
    return {
      action: "steered",
      serializedContext: nextSerializedContext,
      sessionState: nextState,
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
    if (stepResult.settledTurn !== undefined) {
      const taken = takeSessionUsageDelta(stepResult.session);
      const { delta } = taken;
      // A caller held for background work is settled by a later turn; leaving
      // the usage unreported folds this turn's spend into that settlement.
      const reportedSession = hasPendingBackgroundWork(stepResult.session.state)
        ? stepResult.session
        : taken.session;
      return {
        action: "park",
        ...pending,
        serializedContext: nextSerializedContext,
        sessionState: createDurableSessionState({ session: reportedSession }),
        settled: {
          output: stepResult.settledTurn.output,
          isError: stepResult.settledTurn.isError,
          usage: delta,
        },
      };
    }

    return {
      action: "park",
      ...pending,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  return {
    action: "continue",
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}
