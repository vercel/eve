import { createDurableSessionState } from "#execution/durable-session-store.js";
import { derivePendingState } from "#execution/session/pending-turn-state.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";
import type { RunMode } from "#shared/run-mode.js";

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
      const { delta, session } = takeSessionUsageDelta(stepResult.session);
      return {
        action: "park",
        ...pending,
        serializedContext: nextSerializedContext,
        sessionState: createDurableSessionState({ session }),
        settled: {
          output: stepResult.settledTurn.output,
          isError: stepResult.settledTurn.isError,
          ...(stepResult.settledTurn.errorCode === undefined
            ? {}
            : { errorCode: stepResult.settledTurn.errorCode }),
          usage: delta,
        },
      };
    }

    const parked = {
      action: "park" as const,
      ...pending,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
    return stepResult.heldTaskIds === undefined
      ? parked
      : { ...parked, heldTaskIds: stepResult.heldTaskIds };
  }

  return {
    action: "continue",
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}
