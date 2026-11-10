import type { AuthorizationChallenge } from "#harness/authorization.js";
import { signInAttemptKey } from "#harness/hitl/sign-ins.js";
import { signInInteractionId } from "#harness/interaction-facts.js";
import { awaitsProviderToolResult } from "#harness/provider-tool-history.js";
import {
  ownOpenRequestIds,
  runtimeWait,
  waitsAsTasks,
  type SessionView,
} from "#harness/session-machine/view.js";
import { workingTaskIds } from "#execution/tasks/model-step.js";
import { readTaskTable, tasksWithResults } from "#execution/tasks/table.js";
import type { HarnessStepInput, StepResult } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import type { Step } from "./context.js";

// Where a step stops when nothing it holds can run. Every rule a step runs only changes the
// session; none decides that the turn waits. This does, once, from what is still open: a person
// to answer or sign in, calls the runtime runs, or tasks that still work. A turn waiting on a
// person says so. A call that waits on a person as a task never holds the turn: the model goes
// on, and the person's action wakes the turn as a task's result does.

/**
 * Interaction kinds a message can't steer past: it waits, unreceived, until the person answers.
 * Every other kind gives way to the person's message.
 */
const ANSWER_FIRST_KINDS: ReadonlySet<string> = new Set(["budget"]);

/**
 * What calls that wait as tasks wait on: their open approvals, the sign-ins they stopped on that
 * no other call waits on, and the sign-ins responders need before their answers to those
 * approvals count.
 */
export function taskWaits(view: SessionView): {
  readonly requestIds: ReadonlySet<string>;
  readonly signIns: readonly AuthorizationChallenge[];
} {
  const steps = view.turn.suspended.filter(waitsAsTasks);
  const approvals = new Set(steps.flatMap((step) => step.requests.map((ask) => ask.interactionId)));
  const stoppedOn = (tasks: boolean) =>
    new Set(
      view.turn.suspended
        .filter((step) => waitsAsTasks(step) === tasks)
        .flatMap((step) =>
          (step.approved ?? []).flatMap((call) => (call.signIns ?? []).map(signInAttemptKey)),
        ),
    );
  const held = stoppedOn(false);
  const byTasks = new Set([...stoppedOn(true)].filter((key) => !held.has(key)));
  const { responses } = view.projection.view;
  const signIns = view.signIns.filter(
    (challenge) =>
      byTasks.has(signInAttemptKey(challenge)) ||
      (challenge.candidateId !== undefined &&
        approvals.has(responses[challenge.candidateId]?.interactionId ?? "")),
  );
  return { requestIds: new Set([...approvals, ...signIns.map(signInInteractionId)]), signIns };
}

/**
 * Whether the session resumes the turn on a person itself: a request it asked, or its own sign-in,
 * other than what a call that waits as a task waits on. A child's relayed sign-in resumes the turn
 * on its call instead, though readers see a person.
 */
export function resumesOnPerson(view: SessionView): boolean {
  const waits = taskWaits(view);
  return (
    [...ownOpenRequestIds(view)].some((interactionId) => !waits.requestIds.has(interactionId)) ||
    view.signIns.length > waits.signIns.length
  );
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
 * otherwise the turn stops, waiting on the person it asked, on the runtime's calls, or on its
 * tasks, as the turn rule holds it.
 */
export function park(step: Step): StepResult {
  const view = step.view();
  if (hasQueuedTurnInput(view) && !holdsMessages(view)) {
    return { next: step.runStep, session: step.session };
  }
  if (resumesOnPerson(view))
    return { held: { kind: "request" }, next: null, session: step.session };
  const taskIds = workingTaskIds(step.session);
  if (runtimeWait(step.session.state) === undefined && taskIds.length > 0) {
    return { held: { kind: "tasks", taskIds }, next: null, session: step.session };
  }
  return { next: null, session: step.session };
}

/**
 * Whether the model has nothing new to read while tasks work: no input joined the turn, no task
 * result waits, and its last response called nothing. A person's action on a call that waits as a
 * task can leave the turn so, as when the call stops for a sign-in or the answer is refused; the
 * turn then goes back to waiting on its tasks rather than calling the model.
 */
export function nothingToRead(step: Step, input: { readonly hasInput: boolean }): boolean {
  const last = step.session.history.at(-1);
  return (
    !input.hasInput &&
    last?.role === "assistant" &&
    !awaitsProviderToolResult(step.session.history) &&
    tasksWithResults(readTaskTable(step.session.state)).length === 0 &&
    workingTaskIds(step.session).length > 0
  );
}
