import { decideStep, type StepDecision } from "#execution/session/step-decision.js";
import { readStepState } from "#execution/session/step-reading.js";
import { createDurableSessionValues } from "#execution/durable-session-store.js";
import type {
  DurableStepResult,
  DurableStepResultFields,
} from "#execution/session/turn-step-types.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";
import type { HarnessSession, SettledTurn, StepDone, StepResult } from "#harness/types.js";

export function resolveSessionStepResult(
  result: StepResult,
  serializedContext: Record<string, unknown>,
): DurableStepResult {
  const decision = decideStep(readStepState(result.session, result.unreadInput));
  const ended = result.ended;
  if (ended !== undefined && decision.kind !== "end")
    throw new Error("A turn step returned the session's end without ending the session.");
  return durableResult(
    result.session,
    decision,
    {
      serializedContext,
      ...createDurableSessionValues(result.session),
    },
    result.settledTurn,
    ended,
  );
}

export function pausedOrParked(
  session: HarnessSession,
  fields: DurableStepResultFields,
  settled?: SettledTurn,
): DurableStepResult {
  return durableResult(session, decideStep(readStepState(session)), fields, settled);
}

function durableResult(
  session: HarnessSession,
  decision: StepDecision,
  fields: DurableStepResultFields,
  settled?: SettledTurn,
  ended?: StepDone,
): DurableStepResult {
  switch (decision.kind) {
    case "end":
      return {
        action: "done",
        ...fields,
        isError: ended?.isError,
        output: ended?.output,
        usage: sessionUsage(session),
        usageDelta: takeSessionUsageDelta(session).delta,
      };
    case "run":
      return { action: "continue", ...fields };
    case "wait":
      return { action: "paused", ...decision.pause, ...fields };
    case "park": {
      if (settled === undefined) return { action: "parked", ...fields };
      const reported = takeSessionUsageDelta(session);
      return {
        action: "parked",
        serializedContext: fields.serializedContext,
        ...createDurableSessionValues(reported.session),
        settled: { output: settled.output, isError: settled.isError, usage: reported.delta },
      };
    }
  }
}
