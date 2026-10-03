import type { SessionAuthContext } from "#channel/types.js";
import { emitFailedStep } from "#harness/emission.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import { HumanInput, type Transition } from "#harness/human-input/index.js";
import { createFrameworkUserMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type {
  HarnessSession,
  StepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";

type Emit = ToolLoopHarnessConfig["handleEvent"];

interface Applied {
  readonly ended?: StepResult;
  readonly session: HarnessSession;
}

/**
 * Applies what human input reported to the tool loop's session. Each event
 * has one meaning here, so the tool loop decides nothing about a person's
 * input. Returns the step's result when an event ended the turn.
 */
export async function applyHumanInput(input: {
  readonly emit?: Emit;
  /** Where the step stands, should human input fail the turn. */
  readonly emissionState: HarnessEmissionState;
  readonly hasDelegatedCaller: boolean;
  readonly session: HarnessSession;
  readonly transition: Transition;
}): Promise<Applied> {
  const { emit, transition } = input;
  let session: HarnessSession = {
    ...input.session,
    state: transition.humanInput.write(input.session.state),
  };
  for (const event of transition.events) {
    switch (event.type) {
      case "publish":
        await emit?.(event.event);
        continue;
      case "history.appended":
        session = {
          ...session,
          history: validateHarnessModelMessages([...session.history, event.message]),
        };
        continue;
      case "note":
        session = {
          ...session,
          history: validateHarnessModelMessages([
            ...session.history,
            createFrameworkUserMessage("context.instruction", event.text),
          ]),
        };
        continue;
      case "turn.cancelled":
        throw new TurnCancelledError();
      case "turn.failed": {
        // Callers without an emit fn get the raw throw, as for model failures.
        if (!emit) throw new Error(event.message);
        await emitFailedStep(emit, input.emissionState, {
          code: event.code,
          message: event.message,
          sessionId: session.sessionId,
          usage: getSessionUsage(session),
        });
        const next = input.hasDelegatedCaller
          ? { done: true as const, isError: true, output: event.message }
          : { done: true as const, output: "" };
        return { ended: { next, session }, session };
      }
      case "calls.approved":
      case "responder.check":
      case "answer.forwarded":
      case "budget.granted":
        throw new Error(`Human input event "${event.type}" is not implemented.`);
    }
  }
  return { session };
}

/**
 * Hands what arrived for the turn to human input before the step's model
 * call. Returns the step's result when that ends the step; otherwise the
 * input the turn reads.
 */
export async function applyStepArrivals(input: {
  readonly auth: SessionAuthContext | null;
  readonly emit?: Emit;
  readonly emissionState: HarnessEmissionState;
  readonly hasDelegatedCaller: boolean;
  readonly session: HarnessSession;
  readonly stepInput: StepInput | undefined;
}): Promise<
  | { readonly result: StepResult }
  | { readonly session: HarnessSession; readonly turnInput: StepInput | undefined }
> {
  const { emit, emissionState, stepInput } = input;
  let { session } = input;
  const arrivals = HumanInput.read(session.state).arrivals({ sender: input.auth, stepInput });
  for (const intake of arrivals) {
    const applied = await applyHumanInput({
      emit,
      emissionState,
      hasDelegatedCaller: input.hasDelegatedCaller,
      session,
      transition: HumanInput.read(session.state).intake(intake),
    });
    session = applied.session;
    if (applied.ended !== undefined) return { result: applied.ended };
  }
  return { session, turnInput: stepInput };
}
