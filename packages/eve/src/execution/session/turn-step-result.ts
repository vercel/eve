import { createDurableSessionState } from "#execution/durable-session-store.js";
import { derivePendingState } from "#execution/session/pending-turn-state.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";

export function resolveSessionStepResult(
  stepResult: StepResult,
  nextSerializedContext: Record<string, unknown>,
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

  if (stepResult.held !== undefined) {
    return {
      action: "held",
      serializedContext: nextSerializedContext,
      sessionState: nextState,
      taskIds: stepResult.held.taskIds,
    };
  }

  if (stepResult.next === null) {
    const pending = derivePendingState(stepResult.session);

    // Usage stays unreported until the turn settles, so the caller's result includes all of it.
    if (stepResult.settledTurn !== undefined) {
      const { delta, session: reportedSession } = takeSessionUsageDelta(stepResult.session);
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
