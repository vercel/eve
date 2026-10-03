import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import { advanceStep, emitFailedStep, setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import { HumanInput, type Transition } from "#harness/human-input/index.js";
import { createFrameworkUserMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { SessionLimitDeclinedError, TurnCancelledError } from "#harness/turn-cancellation.js";
import { bumpSessionRuntimeUsageLimits, getSessionUsage } from "#harness/turn-tag-state.js";
import type {
  HarnessSession,
  StepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import { createTurnWaitingEvent } from "#protocol/message.js";

import { runApprovedWork, type ApprovedRuntimeCalls } from "./approved-calls.js";
import { prepareStepTools, type StepEffects } from "./step-tools.js";

export type { StepEffects } from "./step-tools.js";

type Emit = ToolLoopHarnessConfig["handleEvent"];

interface Applied {
  readonly ended?: StepResult;
  readonly messageAnswered: boolean;
  /** The suspended step's response, which goes with approved calls that run as runtime work. */
  readonly dispatched?: readonly ModelMessage[];
  readonly runtimeCalls?: ApprovedRuntimeCalls;
  readonly session: HarnessSession;
}

/**
 * Applies what human input reported to the tool loop's session. Each event
 * has one meaning here, so the tool loop decides nothing about a person's
 * input. Running approved calls needs `effects`, which only steps where an
 * answer can arrive pass. Returns the step's result when an event ended the
 * turn.
 */
export async function applyHumanInput(input: {
  readonly effects?: StepEffects;
  readonly emit?: Emit;
  /** Where the step stands, should human input fail the turn. */
  readonly emissionState: HarnessEmissionState;
  readonly hasDelegatedCaller: boolean;
  readonly session: HarnessSession;
  readonly transition: Transition;
}): Promise<Applied> {
  const { effects, emit, transition } = input;
  let session: HarnessSession = {
    ...input.session,
    state: transition.humanInput.write(input.session.state),
  };
  let messageAnswered = false;
  let runtimeCalls: ApprovedRuntimeCalls | undefined;
  let dispatched: readonly ModelMessage[] | undefined;
  const applyNested = async (nested: Transition) => {
    const applied = await applyHumanInput({ ...input, session, transition: nested });
    session = applied.session;
    runtimeCalls ??= applied.runtimeCalls;
    dispatched ??= applied.dispatched;
    return applied.ended;
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
      case "message.answered":
        messageAnswered = true;
        continue;
      case "calls.dispatched":
        dispatched = event.messages;
        continue;
      case "calls.approved": {
        if (effects === undefined) {
          throw new Error("Approved calls can run only where answers arrive.");
        }
        const tools = await prepareStepTools(effects, event.at, session);
        const work = await runApprovedWork({
          ...event,
          abortSignal: effects.config.abortSignal,
          emit,
          messages: [
            ...effects.projectHistory(session.history, session.state),
            ...HumanInput.read(session.state).suspendedMessages(),
          ],
          session,
          tools,
        });
        session = work.session;
        runtimeCalls ??= work.runtimeCalls;
        const settled = await applyNested(
          HumanInput.read(session.state).intake({
            results:
              work.results.length === 0 ? [] : [{ content: [...work.results], role: "tool" }],
            running: work.runtimeCalls?.tasks.map((task) => task.callId) ?? [],
            type: "calls.settled",
          }),
        );
        if (settled !== undefined) {
          return { ended: settled, messageAnswered, dispatched, runtimeCalls, session };
        }
        if (work.signIns !== undefined) {
          const ended = await applyNested(
            HumanInput.read(session.state).interrupt({
              at: event.at,
              callIds: work.signIns.callIds,
              challenges: work.signIns.challenges,
              requester: null,
              type: "authorization.required",
            }),
          );
          if (ended !== undefined) {
            return { ended, messageAnswered, dispatched, runtimeCalls, session };
          }
        }
        continue;
      }
      case "turn.cancelled":
        throw new TurnCancelledError();
      case "budget.granted":
        session = bumpSessionRuntimeUsageLimits(session);
        continue;
      case "budget.declined":
        throw new SessionLimitDeclinedError(event.requestId, transition.humanInput);
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
        return { ended: { next, session }, messageAnswered, session };
      }
      case "responder.check":
      case "answer.forwarded":
        throw new Error(`Human input event "${event.type}" is not implemented.`);
    }
  }
  return { messageAnswered, dispatched, runtimeCalls, session };
}

/**
 * Hands what arrived for the turn to human input before the step's model
 * call. Returns the step's result when that ends, parks, or holds the step;
 * otherwise the input the turn reads, without a message that answered.
 */
export async function applyStepArrivals(input: {
  readonly auth: SessionAuthContext | null;
  readonly effects: StepEffects;
  readonly emit?: Emit;
  readonly emissionState: HarnessEmissionState;
  readonly hasDelegatedCaller: boolean;
  readonly session: HarnessSession;
  readonly stepInput: StepInput | undefined;
}): Promise<
  | { readonly result: StepResult }
  | { readonly session: HarnessSession; readonly turnInput: StepInput | undefined }
> {
  const { effects, emit, emissionState, stepInput } = input;
  let { session } = input;
  let messageAnswered = false;
  let runtimeCalls: ApprovedRuntimeCalls | undefined;
  let dispatched: readonly ModelMessage[] | undefined;
  const arrivals = HumanInput.read(session.state).arrivals({ sender: input.auth, stepInput });
  for (const intake of arrivals) {
    const applied = await applyHumanInput({
      effects,
      emit,
      emissionState,
      hasDelegatedCaller: input.hasDelegatedCaller,
      session,
      transition: HumanInput.read(session.state).intake(intake),
    });
    session = applied.session;
    messageAnswered ||= applied.messageAnswered;
    runtimeCalls ??= applied.runtimeCalls;
    dispatched ??= applied.dispatched;
    if (applied.ended !== undefined) return { result: applied.ended };
  }
  const turnInput = messageAnswered ? withoutMessage(stepInput) : stepInput;
  if (runtimeCalls !== undefined) {
    // The turn's message is read after the approved calls' results; its
    // answers were already applied.
    const following = withoutAnswers(turnInput);
    return {
      result: {
        next: null,
        session: setHarnessEmissionState(
          setPendingCoordinationBatch({
            event: runtimeCalls.at,
            followingInput: following?.message === undefined ? undefined : following,
            // The step's response waits with its runtime calls, out of history.
            responseMessages: dispatched ?? [],
            session,
            tasks: runtimeCalls.tasks,
          }),
          advanceStep(emissionState),
        ),
      },
    };
  }
  // A message that answers nothing still joins history, so it is read once
  // the turn runs again; the hold before the model call keeps it.
  if ("held" in HumanInput.read(session.state).next() && turnInput?.message === undefined) {
    return { result: await holdForInput({ emit, emissionState, session }) };
  }
  return { session, turnInput };
}

/**
 * The turn waits on a person, as it waits on a task: it reports `turn.waiting`
 * and resumes in the same turn once the person answers, steers, or cancels.
 */
export async function holdForInput(input: {
  readonly emit?: Emit;
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
}): Promise<StepResult> {
  const next = advanceStep(input.emissionState);
  await input.emit?.(
    createTurnWaitingEvent({
      on: "input",
      sequence: next.sequence,
      turnId: next.turnId,
      usage: getSessionUsage(input.session),
    }),
  );
  return {
    held: { kind: "input" },
    next: null,
    session: setHarnessEmissionState(input.session, next),
  };
}

/** A message that answered requests isn't turn input, nor is the context sent with it. */
function withoutMessage(input: StepInput | undefined): StepInput | undefined {
  if (input === undefined) return undefined;
  const { context: _context, message: _message, ...rest } = input;
  return rest;
}

function withoutAnswers(input: StepInput | undefined): StepInput | undefined {
  if (input === undefined) return undefined;
  const { attributedInputResponses: _attributed, inputResponses: _responses, ...rest } = input;
  return rest;
}
