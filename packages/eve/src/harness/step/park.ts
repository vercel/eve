import { runtimeWait, type SessionView, ownOpenRequestIds } from "#harness/session-machine/view.js";
import type { HarnessStepInput, StepResult } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import type { Step } from "./context.js";

// Where a step stops when nothing it holds can run. Every rule a step runs only changes the
// session; none decides that the turn waits. This does, once, from what is still open: a person
// to answer or sign in, or calls the runtime runs. A turn waiting on a person says so.

/**
 * Interaction kinds a message can't steer past: it waits, unreceived, until the person answers.
 * Every other kind gives way to the person's message.
 */
const ANSWER_FIRST_KINDS: ReadonlySet<string> = new Set(["budget"]);

/**
 * Whether the session resumes the turn on a person itself: a request it asked, or its own sign-in.
 * A child's relayed sign-in resumes the turn on its call instead, though readers see a person.
 */
export function resumesOnPerson(view: SessionView): boolean {
  return ownOpenRequestIds(view).size > 0 || view.signIns.length > 0;
}

/** Whether an open request takes its answer before any message: the message waits behind it. */
export function holdsMessages(view: SessionView): boolean {
  const tables = view.projection.view;
  return [...ownOpenRequestIds(view)].some((interactionId) =>
    ANSWER_FIRST_KINDS.has(tables.interactions[interactionId]?.request.kind ?? ""),
  );
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

/**
 * Nothing the step holds can run. Input the turn holds runs next step, past whatever it steers;
 * otherwise the turn stops, waiting on the person it asked or on the runtime's calls.
 */
export function park(step: Step): StepResult {
  const view = step.view();
  if (hasQueuedTurnInput(view) && !holdsMessages(view)) {
    return { next: step.runStep, session: step.session };
  }
  if (resumesOnPerson(view))
    return { held: { kind: "request" }, next: null, session: step.session };
  return { next: null, session: step.session };
}
