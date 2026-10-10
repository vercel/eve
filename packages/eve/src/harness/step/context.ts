import type { ModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import { ParentSessionKey, SessionCallbackKey, SessionPredecessorKey } from "#context/keys.js";
import { takeUserInstructionMessages } from "#reactions/kinds/instructions.js";
import { isDynamicModelSelectionError } from "#reactions/kinds/model.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import {
  applyTransition,
  type Publish,
  sessionView,
  type Transition,
} from "#harness/session-machine/commit.js";
import { recordAppliedSession, type StepProjection } from "#harness/session-machine/current.js";
import { fail, receive } from "#harness/session-machine/transitions.js";
import {
  activeTurnId,
  type SessionView,
  turnPosition,
  type TurnPosition,
} from "#harness/session-machine/view.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type {
  HarnessEmitFn,
  HarnessSession,
  StepFn,
  HarnessStepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import type { InstrumentationStepScope } from "#instrumentation/runtime.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { createHistoryViewPreparer } from "#shared/history-view.js";

type HistoryViewPreparer = ReturnType<typeof createHistoryViewPreparer>;

const log = createLogger("harness.step");

/**
 * One harness step: the session it changes, and the machine it changes the session through.
 * Every lifecycle change goes through `apply`, which publishes the transition's events and saves
 * what it changed; `position` reads where those events left the session.
 */
export interface Step {
  session: HarnessSession;
  frameworkToolNames: ReadonlySet<string>;
  readonly config: ToolLoopHarnessConfig;
  /** The step's context; direct harness tests may run without one. */
  readonly ctx: AlsContext | undefined;
  readonly runStep: StepFn;
  readonly publish: Publish;
  /** The caller's event handler. Without one, a failure throws instead of being reported. */
  readonly emit: HarnessEmitFn | undefined;
  readonly instrumentation: InstrumentationStepScope<HarnessSession> | undefined;
  /** A child's caller or a schedule hears only the turn's real end. */
  readonly hasDelegatedCaller: boolean;
  view(): SessionView;
  position(): TurnPosition;
  apply(transition: Transition, messages?: readonly ModelMessage[]): Promise<void>;
  /** History as the model and hooks see it, under `state`, the session's by default. */
  projectHistory(
    messages: readonly ModelMessage[],
    state?: HarnessSession["state"],
  ): readonly ModelMessage[];
}

export function createStep(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly ctx: AlsContext | undefined;
  readonly emit: HarnessEmitFn | undefined;
  readonly instrumentation: InstrumentationStepScope<HarnessSession> | undefined;
  readonly live: StepProjection;
  readonly prepareHistory: HistoryViewPreparer;
  readonly publish: Publish;
  readonly runStep: StepFn;
  readonly session: HarnessSession;
}): Step {
  const { ctx, live } = input;
  const step: Step = {
    session: input.session,
    frameworkToolNames: new Set(),
    config: input.config,
    ctx,
    runStep: input.runStep,
    publish: input.publish,
    emit: input.emit,
    instrumentation: input.instrumentation,
    hasDelegatedCaller:
      ctx?.get(ParentSessionKey) !== undefined || ctx?.get(SessionCallbackKey) !== undefined,
    view: () => sessionView(live.read(), step.session.state),
    position: () => turnPosition(live.read()),
    async apply(transition, messages) {
      step.session = await applyTransition(step.session, transition, input.publish, messages);
      if (ctx !== undefined) recordAppliedSession(ctx, step.session);
    },
    projectHistory: (messages, state = step.session.state) =>
      input.prepareHistory(messages, state).messages,
  };
  return step;
}

/**
 * Opens the turn, or joins the open one. User-role dynamic instructions that changed with the
 * turn's start join history ahead of its input. Returns the step's result when opening failed the
 * session.
 */
export async function openTurn(
  step: Step,
  opened: {
    readonly input: readonly HarnessModelMessage[];
    readonly message?: HarnessStepInput["message"];
    /** The deliveries the turn consumes. */
    readonly deliveries?: HarnessStepInput["deliveries"];
  },
): Promise<StepResult | undefined> {
  const { config, ctx } = step;
  let failure: { readonly error: unknown } | undefined;
  try {
    const position = step.position();
    const trace = await step.instrumentation?.preparePreamble({
      sequence: position.sequence,
      sessionStarted: position.sessionStarted,
      traceContext: step.instrumentation?.traceContext,
      turnId: activeTurnId(position),
    });
    await step.apply(
      receive(step.view(), {
        deliveries: opened.deliveries,
        predecessor: ctx?.get(SessionPredecessorKey),
        runtime: config.runtimeIdentity,
        trace,
      }),
      step.projectHistory([...step.session.history, ...opened.input]),
    );
  } catch (error) {
    failure = { error };
  }
  const instructionMessages = ctx === undefined ? [] : takeUserInstructionMessages(ctx);
  if (instructionMessages.length > 0) {
    step.session = {
      ...step.session,
      history: validateHarnessModelMessages([...step.session.history, ...instructionMessages]),
    };
  }
  if (failure !== undefined) return failBoundaryEvent(step, failure.error);
  step.instrumentation?.setTurnId(step.position().turnId);
  return undefined;
}

/** A lifecycle event failed to publish: a dynamic model selection failure ends the session. */
export async function failBoundaryEvent(step: Step, error: unknown): Promise<StepResult> {
  throwIfTurnAborted(step.config.abortSignal);
  if (isTurnCancellation(error)) throw error;
  if (isDynamicModelSelectionError(error)) return failModelSelection(step, error);
  throw error;
}

/** No model can serve the turn: the session fails. */
export async function failModelSelection(step: Step, error: unknown): Promise<StepResult> {
  throwIfTurnAborted(step.config.abortSignal);
  step.instrumentation?.recordError(error);
  if (step.emit === undefined) throw error;

  const errorId = createErrorId();
  const message = toErrorMessage(error);
  const { session } = step;
  log.error("model selection failed terminally", {
    error,
    errorId,
    sessionId: session.sessionId,
    turnId: activeTurnId(step.position()),
  });
  await step.apply(
    fail(step.view(), {
      code: "MODEL_SELECTION_FAILED",
      details: { errorId },
      message,
      terminal: { sessionId: session.sessionId },
    }),
  );
  return {
    next: step.hasDelegatedCaller
      ? { done: true, isError: true, output: message }
      : { done: true, output: "" },
    session: step.session,
  };
}
