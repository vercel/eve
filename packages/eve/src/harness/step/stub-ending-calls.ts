import { EndingStubCallsKey } from "#context/providers/tool-stubs-key.js";
import { activeTurnId } from "#harness/session-machine/view.js";
import { recordEndingStubCalls } from "#tool-stubs/ending-calls.js";
import type { Step } from "./context.js";

/** Saves the calls this step's stubs answered with `endsTurn`, which only the step's memory holds. */
export function recordStepEndingStubCalls(step: Step): void {
  const calls = step.ctx?.get(EndingStubCallsKey);
  if (calls === undefined) return;
  step.session = recordEndingStubCalls(step.session, activeTurnId(step.position()), calls);
}
