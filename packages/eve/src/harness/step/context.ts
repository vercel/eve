import type { ModelMessage } from "ai";

import type { SessionEvent } from "#protocol/session-event.js";

import type { AlsContext, ContextContainer } from "#context/container.js";
import {
  ParentSessionKey,
  ScheduleIdKey,
  SessionCallbackKey,
  SessionPredecessorKey,
} from "#context/keys.js";
import { takeTurnFailure } from "#reactions/intents.js";
import { takeUserInstructionMessages } from "#reactions/kinds/instructions.js";
import { isDynamicModelSelectionError } from "#reactions/kinds/model.js";
import { evaluateValues, isReactionFailedError } from "#reactions/runner.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import {
  applyTransition,
  dropClosedRecords,
  type Publish,
  sessionView,
  type Transition,
} from "#harness/session-machine/commit.js";
import { recordAppliedSession, type StepProjection } from "#harness/session-machine/current.js";
import { fail, receive } from "#harness/session-machine/transitions.js";
import { withClientContext, type Prompt } from "#harness/step/prompt.js";
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
  HarnessStepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import type { InstrumentationStepScope } from "#instrumentation/runtime.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";

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
  readonly publish: Publish;
  /** The caller's event handler. Without one, a failure throws instead of being reported. */
  readonly emit: HarnessEmitFn | undefined;
  readonly instrumentation: InstrumentationStepScope<HarnessSession> | undefined;
  /** A child's caller or a schedule hears only the turn's real end. */
  readonly hasDelegatedCaller: boolean;
  /**
   * The session's reader sees only its final reply: a child's caller or a schedule. A held turn's
   * text there narrates; a person reads it as a reply.
   */
  readonly finalReplyOnly: boolean;
  view(): SessionView;
  position(): TurnPosition;
  /** Publishes a transition, or facts that change nothing private, as one commit. */
  apply(
    change: Transition | readonly SessionEvent[],
    messages?: readonly ModelMessage[],
  ): Promise<void>;
}

export function createStep(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly ctx: AlsContext | undefined;
  readonly emit: HarnessEmitFn | undefined;
  readonly instrumentation: InstrumentationStepScope<HarnessSession> | undefined;
  readonly live: StepProjection;
  readonly publish: Publish;
  readonly session: HarnessSession;
}): Step {
  const { ctx, live } = input;
  const hasDelegatedCaller =
    ctx?.get(ParentSessionKey) !== undefined || ctx?.get(SessionCallbackKey) !== undefined;
  const step: Step = {
    session: input.session,
    frameworkToolNames: new Set(),
    config: input.config,
    ctx,
    publish: input.publish,
    emit: input.emit,
    instrumentation: input.instrumentation,
    hasDelegatedCaller,
    finalReplyOnly: hasDelegatedCaller || ctx?.get(ScheduleIdKey) !== undefined,
    view: () => sessionView(live.read(), step.session.state),
    position: () => turnPosition(live.read()),
    async apply(change, messages) {
      const transition = "events" in change ? change : { events: change, turn: step.view().turn };
      // Records whose rows the commit closed retire with it; the writer closes and scopes.
      step.session = dropClosedRecords(
        await applyTransition(step.session, transition, input.publish, messages),
        live.read(),
      );
      if (ctx !== undefined) recordAppliedSession(ctx, step.session);
    },
  };
  return step;
}

/** Opens the turn, or joins the open one. Returns the step's result when opening failed the session. */
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
      [...step.session.history, ...opened.input],
    );
  } catch (error) {
    failure = { error };
  }
  if (failure !== undefined) return failBoundaryEvent(step, failure.error);
  step.instrumentation?.setTurnId(step.position().turnId);
  return undefined;
}

/**
 * Before a model call: the session's dynamic values are evaluated with the conversation the call
 * reads, and user-role instructions from new occurrences join history, ahead of the turn's input
 * on its first call. A value that fails fails the turn; returns the step's result then.
 */
export async function prepareModelCall(
  step: Step,
  preview: Prompt,
): Promise<StepResult | undefined> {
  // The step's context is the session's container; direct harness tests run without one.
  const ctx = step.ctx as ContextContainer | undefined;
  if (ctx === undefined) return undefined;
  throwIfTurnAborted(step.config.abortSignal);
  try {
    await evaluateValues(ctx, {
      abortSignal: step.config.abortSignal,
      conversation: validateHarnessModelMessages(withClientContext(preview)),
    });
  } catch (error) {
    if (!isReactionFailedError(error)) throw error;
    return failTurn(step, error, "REACTION_FAILED");
  }
  const instructionMessages = takeUserInstructionMessages(ctx);
  if (instructionMessages.length > 0) {
    step.session = {
      ...step.session,
      history: validateHarnessModelMessages([...step.session.history, ...instructionMessages]),
    };
  }
  return undefined;
}

/** A hook failed during the turn: the turn fails. Returns the step's result then. */
export async function failTurnForReaction(step: Step): Promise<StepResult | undefined> {
  const reason = takeTurnFailure(step.ctx as ContextContainer | undefined);
  if (reason === undefined) return undefined;
  return failTurn(step, new Error(reason), "HOOK_FAILED");
}

/** The turn fails with `error`; the session waits for its next message. */
async function failTurn(step: Step, error: unknown, code: string): Promise<StepResult> {
  throwIfTurnAborted(step.config.abortSignal);
  step.instrumentation?.recordError(error);
  const message = toErrorMessage(error);
  const errorId = createErrorId();
  log.error("turn failed", {
    code,
    error,
    errorId,
    sessionId: step.session.sessionId,
    turnId: activeTurnId(step.position()),
  });
  await step.apply(fail(step.view(), { code, details: { errorId }, message }));
  return {
    session: step.session,
    settledTurn: { isError: true, output: message },
  };
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
      terminal: true,
    }),
  );
  return {
    ended: step.hasDelegatedCaller ? { isError: true, output: message } : { output: "" },
    session: step.session,
  };
}
