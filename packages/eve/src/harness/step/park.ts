import { runtimeWait, type SessionView, ownOpenRequestIds } from "#harness/session-machine/view.js";
import type { HarnessStepInput, StepResult } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import type { Step } from "./context.js";

const ANSWER_FIRST_KINDS: ReadonlySet<string> = new Set(["budget"]);

export function resumesOnPerson(view: SessionView): boolean {
  return ownOpenRequestIds(view).size > 0 || view.signIns.length > 0;
}

export function holdsMessages(view: SessionView): boolean {
  const tables = view.projection.view;
  return [...ownOpenRequestIds(view)].some((interactionId) =>
    ANSWER_FIRST_KINDS.has(tables.interactions[interactionId]?.request.kind ?? ""),
  );
}

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

export function blocked(view: SessionView, state: Step["session"]["state"]): boolean {
  return resumesOnPerson(view) || runtimeWait(state) !== undefined;
}

export function park(step: Step): StepResult {
  const view = step.view();
  if (hasQueuedTurnInput(view) && !holdsMessages(view)) {
    return { next: step.runStep, session: step.session };
  }
  if (resumesOnPerson(view))
    return { held: { kind: "request" }, next: null, session: step.session };
  return { next: null, session: step.session };
}
