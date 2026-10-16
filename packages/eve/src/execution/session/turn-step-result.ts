import { decideStep, readStepState, type StepDecision } from "#execution/session/step-decision.js";
import type {
  DurableStepResult,
  DurableStepResultFields,
} from "#execution/session/turn-step-types.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";
import type { HarnessSession, StepResult } from "#harness/types.js";

/**
 * A turn step's durable result: what the step reported, with what happens next decided from the
 * session it left. `fields` is the state the result carries for a session.
 */
export function resolveSessionStepResult(
  stepResult: StepResult,
  fields: (session: HarnessSession) => DurableStepResultFields,
): DurableStepResult {
  return durableResult(stepResult, decideStep(readStepState(stepResult.session)), fields);
}

function durableResult(
  { ended, session, settledTurn }: StepResult,
  decision: StepDecision,
  fields: (session: HarnessSession) => DurableStepResultFields,
): DurableStepResult {
  switch (decision.kind) {
    case "end":
      return {
        action: "done",
        isError: ended?.isError,
        output: ended?.output,
        ...fields(session),
        usage: sessionUsage(session),
        usageDelta: takeSessionUsageDelta(session).delta,
      };
    case "run":
      return { action: "continue", ...fields(session) };
    case "wait":
      return { action: "paused", ...decision.pause, ...fields(session) };
    case "park": {
      if (settledTurn === undefined) return { action: "parked", ...fields(session) };
      // Usage stays unreported until the turn settles, so the caller's result includes all of it.
      const reported = takeSessionUsageDelta(session);
      return {
        action: "parked",
        settled: {
          isError: settledTurn.isError,
          output: settledTurn.output,
          usage: reported.delta,
        },
        ...fields(reported.session),
      };
    }
  }
}
