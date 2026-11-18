import { unchangedBy } from "#harness/session-machine/commit.js";
import type { ModelChoice } from "#definitions/model.js";
import type { RuntimeModelReference } from "#runtime/agent/bootstrap.js";
import type { ModelMessage } from "ai";

import type { AlsContext, ContextContainer } from "#context/container.js";
import {
  ParentSessionKey,
  ScheduleIdKey,
  SessionCallbackKey,
  SessionPredecessorKey,
} from "#context/keys.js";
import { takeTurnFailure } from "#definitions/intents.js";
import { isDynamicModelSelectionError } from "#definitions/model.js";
import { DefinitionFailedError } from "#definitions/kernel.js";
import { evaluateStepValues } from "#definitions/step.js";
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
  StepFn,
  HarnessStepInput,
  StepResult,
  KernelConfig,
  Commit,
} from "#harness/types.js";
import type { InstrumentationStepScope } from "#instrumentation/runtime.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("harness.step");

export interface Step {
  session: HarnessSession;
  model?: ModelChoice;
  frameworkToolNames: ReadonlySet<string>;
  readonly config: KernelConfig;
  readonly ctx: AlsContext;
  readonly runStep: StepFn;
  readonly publish: Publish;
  readonly emit: HarnessEmitFn | undefined;
  readonly instrumentation: InstrumentationStepScope<HarnessSession> | undefined;
  readonly hasDelegatedCaller: boolean;
  readonly finalReplyOnly: boolean;
  readonly endsTurn: boolean;
  view(): SessionView;
  position(): TurnPosition;
  apply(change: Transition | Commit, messages?: readonly ModelMessage[]): Promise<void>;
}

export function stepReference(step: Pick<Step, "model">): RuntimeModelReference {
  if (step.model === undefined) throw new Error("The step read its model before eve chose it.");
  return step.model.reference;
}

export function createStep(input: {
  readonly config: KernelConfig;
  readonly ctx: AlsContext;
  readonly emit: HarnessEmitFn | undefined;
  readonly instrumentation: InstrumentationStepScope<HarnessSession> | undefined;
  readonly live: StepProjection;
  readonly publish: Publish;
  readonly runStep: StepFn;
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
    runStep: input.runStep,
    publish: input.publish,
    emit: input.emit,
    instrumentation: input.instrumentation,
    hasDelegatedCaller,
    finalReplyOnly: hasDelegatedCaller || ctx?.get(ScheduleIdKey) !== undefined,
    endsTurn: !hasDelegatedCaller && input.session.outputSchema === undefined,
    view: () => sessionView(live.read(), step.session.state),
    position: () => turnPosition(live.read()),
    async apply(change, messages) {
      const transition = "events" in change ? change : unchangedBy(change, step.view().turn);
      step.session = dropClosedRecords(
        await applyTransition(step.session, transition, input.publish, messages),
        live.read(),
      );
      if (ctx !== undefined) recordAppliedSession(ctx, step.session);
    },
  };
  return step;
}

export async function openTurn(
  step: Step,
  opened: {
    readonly input: readonly HarnessModelMessage[];
    readonly message?: HarnessStepInput["message"];
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

export async function prepareModelCall(
  step: Step,
  preview: Prompt,
): Promise<StepResult | undefined> {
  throwIfTurnAborted(step.config.abortSignal);
  const conversation = validateHarnessModelMessages(withClientContext(preview));
  try {
    await evaluateStepValues(step, { abortSignal: step.config.abortSignal, conversation });
  } catch (error) {
    if (!(error instanceof DefinitionFailedError)) throw error;
    return failTurn(step, error, "REACTION_FAILED");
  }
  return undefined;
}

export async function failTurnForEffect(step: Step): Promise<StepResult | undefined> {
  const reason = takeTurnFailure(step.ctx as ContextContainer);
  if (reason === undefined) return undefined;
  return failTurn(step, new Error(reason), "HOOK_FAILED");
}

export async function failTurn(
  step: Step,
  error: unknown,
  code: string,
  message = toErrorMessage(error),
): Promise<StepResult> {
  throwIfTurnAborted(step.config.abortSignal);
  step.instrumentation?.recordError(error);
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
    next: null,
    session: step.session,
    settledTurn: { isError: true, output: message },
  };
}

export async function failBoundaryEvent(step: Step, error: unknown): Promise<StepResult> {
  throwIfTurnAborted(step.config.abortSignal);
  if (isDynamicModelSelectionError(error)) return failModelSelection(step, error);
  throw error;
}

export async function failModelSelection(step: Step, error: unknown): Promise<StepResult> {
  throwIfTurnAborted(step.config.abortSignal);
  if (isTurnCancellation(error)) throw error;
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
    next: step.hasDelegatedCaller
      ? { done: true, isError: true, output: message }
      : { done: true, output: "" },
    session: step.session,
  };
}
