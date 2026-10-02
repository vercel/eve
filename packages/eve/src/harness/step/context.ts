import type { ModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import {
  drainDynamicInstructionUserMessages,
  prepareDynamicInstructionPreamble,
} from "#context/dynamic-instruction-lifecycle.js";
import { isDynamicModelSelectionError } from "#context/dynamic-model-lifecycle.js";
import { ParentSessionKey, SessionCallbackKey } from "#context/keys.js";
import { drainMemoryCommit, prepareMemoryPreamble } from "#context/memory-lifecycle.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import {
  emitFailedStep,
  emitTurnPreamble,
  getHarnessEmissionState,
  type HarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type {
  HarnessEmitFn,
  HarnessSession,
  StepFn,
  StepInput,
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
 * One harness step: the session it changes, and where its events leave the session's turn.
 */
export interface Step {
  session: HarnessSession;
  readonly config: ToolLoopHarnessConfig;
  /** The step's context; direct harness tests may run without one. */
  readonly ctx: AlsContext | undefined;
  readonly runStep: StepFn;
  /**
   * The step's event handler. Without one, the step reports no lifecycle, and a failure throws
   * instead of being reported.
   */
  readonly emit: HarnessEmitFn | undefined;
  readonly instrumentation: InstrumentationStepScope<HarnessSession> | undefined;
  /** A child's caller or a schedule hears only the turn's real end. */
  readonly hasDelegatedCaller: boolean;
  /** Where the step's events have left the session's turn. */
  position(): HarnessEmissionState;
  /** Records where the step's events left the turn. */
  moveTo(position: HarnessEmissionState): void;
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
  readonly prepareHistory: HistoryViewPreparer;
  readonly runStep: StepFn;
  readonly session: HarnessSession;
}): Step {
  const { ctx } = input;
  const step: Step = {
    session: input.session,
    config: input.config,
    ctx,
    runStep: input.runStep,
    emit: input.emit,
    instrumentation: input.instrumentation,
    hasDelegatedCaller:
      ctx?.get(ParentSessionKey) !== undefined || ctx?.get(SessionCallbackKey) !== undefined,
    position: () => getHarnessEmissionState(step.session.state),
    moveTo(position) {
      step.session = setHarnessEmissionState(step.session, position);
    },
    projectHistory: (messages, state = step.session.state) =>
      input.prepareHistory(messages, state).messages,
  };
  return step;
}

/**
 * Opens the turn, or joins the open one, with the preamble its hooks prepare: memory recall and
 * dynamic instructions join history ahead of the turn's input. `pending` is the transcript the
 * step resumes, which follows the preamble so an approval response stays last. Returns the step's
 * result when the preamble failed the session.
 */
export async function openTurn(
  step: Step,
  opened: {
    readonly pending: readonly HarnessModelMessage[];
    readonly input: readonly HarnessModelMessage[];
    readonly message?: StepInput["message"];
  },
): Promise<StepResult | undefined> {
  const { config, ctx, emit } = step;
  if (emit === undefined) return undefined;
  const history = [...step.session.history, ...opened.pending];
  if (ctx !== undefined) {
    prepareDynamicInstructionPreamble(ctx, step.projectHistory(step.session.history));
    prepareMemoryPreamble(ctx, {
      history,
      input: [...opened.input],
      projector: config.historyProjector,
      state: step.session.state,
    });
  }
  const before = step.position();
  let preamble: { readonly opened: HarnessEmissionState } | { readonly error: unknown };
  try {
    const trace = await step.instrumentation?.preparePreamble({
      sequence: before.sequence,
      sessionStarted: before.sessionStarted,
      traceContext: step.instrumentation?.traceContext,
      turnId: activeTurnId(before),
    });
    preamble = {
      opened: await emitTurnPreamble(
        emit,
        { message: opened.message },
        before,
        step.projectHistory([...history, ...opened.input]),
        config.runtimeIdentity,
        trace,
      ),
    };
  } catch (error) {
    preamble = { error };
  }
  // The hooks' pending state drains even when the preamble failed.
  const instructionMessages = ctx === undefined ? [] : drainDynamicInstructionUserMessages(ctx);
  const memoryCommit = ctx === undefined ? undefined : drainMemoryCommit(ctx);
  step.session = {
    ...step.session,
    history: validateHarnessModelMessages([
      ...step.session.history,
      ...(memoryCommit?.recalledMessages ?? []),
      ...instructionMessages,
    ]),
    state: memoryCommit?.state ?? step.session.state,
  };
  if ("error" in preamble) {
    return failBoundaryEvent(step, preamble.error, {
      sessionStarted: true,
      sequence: before.sequence,
      stepIndex: 0,
      turnId: activeTurnId(before),
    });
  }
  step.moveTo(preamble.opened);
  step.instrumentation?.setTurnId(preamble.opened.turnId);
  return undefined;
}

/** A lifecycle event failed to publish: only a dynamic model selection failure is reported. */
export async function failBoundaryEvent(
  step: Step,
  error: unknown,
  at: HarnessEmissionState = step.position(),
): Promise<StepResult> {
  throwIfTurnAborted(step.config.abortSignal);
  if (isTurnCancellation(error)) throw error;
  if (isDynamicModelSelectionError(error)) return failModelSelection(step, error, at);
  throw error;
}

/** No model can serve the turn: the session fails. */
export async function failModelSelection(
  step: Step,
  error: unknown,
  at: HarnessEmissionState = step.position(),
): Promise<StepResult> {
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
    turnId: at.turnId,
  });
  await emitFailedStep(step.emit, at, {
    code: "MODEL_SELECTION_FAILED",
    details: { errorId },
    message,
    sessionId: session.sessionId,
    usage: getSessionUsage(session),
  });
  return {
    next: step.hasDelegatedCaller
      ? { done: true, isError: true, output: message }
      : { done: true, output: "" },
    session,
  };
}
