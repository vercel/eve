import type { HarnessSession, StepInput } from "#harness/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";

const DEFERRED_STEP_INPUT_KEY = "eve.runtime.deferredStepInput";

/**
 * Merges any queued follow-up input into the current step input and clears it
 * from session state. When `preferCurrentInput` is set, fresh input is returned
 * alone and the queued input remains deferred.
 *
 * Used when the harness has to process a pending tool-approval response first
 * and defer the user's new message to the next internal model step.
 */
export function consumeDeferredStepInput(input: {
  readonly input?: StepInput;
  readonly preferCurrentInput?: boolean;
  readonly session: HarnessSession;
}): {
  readonly input?: StepInput;
  readonly session: HarnessSession;
} {
  const deferredInput = getDeferredStepInput(input.session);

  if (deferredInput === undefined) {
    return input;
  }

  // A fresh task delivery may answer the request that caused the deferral.
  // Resolve it alone, leaving the older turn input queued for the next step.
  if (input.preferCurrentInput === true && input.input !== undefined) {
    return { input: input.input, session: input.session };
  }

  const session = clearDeferredStepInput(input.session);

  if (input.input === undefined) {
    return {
      input: deferredInput,
      session,
    };
  }

  return {
    input: coalesceTurnInputs(deferredInput, input.input),
    session,
  };
}

/**
 * Returns true when the session carries queued follow-up input for the next
 * internal harness step.
 */
export function hasDeferredStepInput(session: HarnessSession): boolean {
  return getDeferredStepInput(session) !== undefined;
}

function getDeferredStepInput(session: HarnessSession): StepInput | undefined {
  return session.state?.[DEFERRED_STEP_INPUT_KEY] as StepInput | undefined;
}

export function queueDeferredStepInput(session: HarnessSession, input: StepInput): HarnessSession {
  const existing = getDeferredStepInput(session);
  const deferredInput = existing === undefined ? input : coalesceTurnInputs(existing, input);
  const state = { ...session.state };
  state[DEFERRED_STEP_INPUT_KEY] = deferredInput;

  return {
    ...session,
    state,
  };
}

function clearDeferredStepInput(session: HarnessSession): HarnessSession {
  if (session.state?.[DEFERRED_STEP_INPUT_KEY] === undefined) {
    return session;
  }

  const state = { ...session.state };
  delete state[DEFERRED_STEP_INPUT_KEY];

  return {
    ...session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };
}
