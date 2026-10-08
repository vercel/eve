import { storedProjection } from "#harness/session-machine/view.js";
import { createDurableSessionValues } from "#execution/durable-session-store.js";
import {
  pausedOnCalls,
  pausedOnPerson,
  pausedOnTasks,
} from "#execution/session/pending-turn-state.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";

export function resolveSessionStepResult(
  stepResult: StepResult,
  nextSerializedContext: Record<string, unknown>,
): DurableStepResult {
  const values = {
    serializedContext: nextSerializedContext,
    ...createDurableSessionValues(stepResult.session),
  };
  // Steering cut the model call short; the next step reads it.
  if (stepResult.steered) return { action: "continue", ...values };

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
      ...values,
      usage: sessionTotals === undefined ? undefined : toUsage(sessionTotals),
      usageDelta: takeSessionUsageDelta(stepResult.session).delta,
    };
  }

  if (stepResult.held?.kind === "tasks") {
    return { action: "paused", ...pausedOnTasks(stepResult.held.taskIds), ...values };
  }
  if (stepResult.held?.kind === "request") {
    const projection = storedProjection(stepResult.session.state);
    return { action: "paused", ...pausedOnPerson(stepResult.session, projection), ...values };
  }
  if (stepResult.next !== null) return { action: "continue", ...values };

  // Usage stays unreported until the turn settles, so the caller's result includes all of it.
  const reported =
    stepResult.settledTurn === undefined ? undefined : takeSessionUsageDelta(stepResult.session);
  const parked =
    reported === undefined
      ? values
      : {
          serializedContext: nextSerializedContext,
          ...createDurableSessionValues(reported.session),
        };
  const calls = pausedOnCalls(stepResult.session);
  if (calls !== undefined) return { action: "paused", ...calls, ...parked };
  return {
    action: "parked",
    ...(stepResult.settledTurn !== undefined && {
      settled: {
        output: stepResult.settledTurn.output,
        isError: stepResult.settledTurn.isError,
        usage: reported?.delta,
      },
    }),
    ...parked,
  };
}
