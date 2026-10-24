import { runtimeWait, type SessionView, ownOpenRequestIds } from "#harness/session-machine/view.js";
import type { HarnessStepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import type { Step } from "./context.js";

/**
 * Whether the session resumes the turn on a person itself: a request it asked, or its own sign-in.
 * A child's relayed sign-in resumes the turn on its call instead, though readers see a person.
 */
export function resumesOnPerson(view: SessionView): boolean {
  return ownOpenRequestIds(view).size > 0 || view.signIns.length > 0;
}

/** Whether the turn holds input it hasn't taken. */
export function hasQueuedTurnInput(view: SessionView): boolean {
  const queued: HarnessStepInput | undefined = view.turn.queued;
  return (
    queued !== undefined &&
    (queued.message !== undefined ||
      (queued.context?.length ?? 0) > 0 ||
      queued.outputSchema !== undefined ||
      readClientContext(queued) !== undefined ||
      (queued.runtimeActionResults?.length ?? 0) > 0)
  );
}

/** Whether anything open stops the turn from calling the model. */
export function blocked(view: SessionView, state: Step["session"]["state"]): boolean {
  return resumesOnPerson(view) || runtimeWait(state) !== undefined;
}
