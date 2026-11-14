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
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import { SignInCompletedKey } from "#harness/authorization.js";
import { modelSignInReporter } from "#harness/hitl/index.js";
import { SIGN_IN_DECLINED } from "#harness/hitl/sign-ins.js";
import { displayProperName } from "#protocol/session-projection/display-name.js";
import { isScopedAuthorizationRequiredError } from "#runtime/connections/scoped-authorization.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
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

/**
 * One harness step: the session it changes, and the machine it changes the session through.
 * Every lifecycle change goes through `apply`, which publishes the transition's events and saves
 * what it changed; `position` reads where those events left the session.
 */
export interface Step {
  session: HarnessSession;
  /** The model the step's call runs, once eve has chosen it for the call. */
  model?: ModelChoice;
  frameworkToolNames: ReadonlySet<string>;
  readonly config: KernelConfig;
  /** The session's context. */
  readonly ctx: AlsContext;
  readonly runStep: StepFn;
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
  /** A tool's `endsTurn` applies: a root turn without an output schema. */
  readonly endsTurn: boolean;
  view(): SessionView;
  position(): TurnPosition;
  /** Publishes a transition, or kernel facts that change nothing private, as one commit. */
  apply(change: Transition | Commit, messages?: readonly ModelMessage[]): Promise<void>;
}

/** The model the step's call runs. Read only once eve has chosen it for the call. */
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
 * Before a model call: eve evaluates the session's dynamic values with the call's conversation.
 * Then the call runs, the turn handles a value's sign-in, or the turn fails.
 */
export async function prepareModelCall(step: Step, preview: Prompt): Promise<ModelCallPreparation> {
  throwIfTurnAborted(step.config.abortSignal);
  const conversation = validateHarnessModelMessages(withClientContext(preview));
  step.ctx.setVirtualContext(SignInCompletedKey, modelSignInReporter(step));
  try {
    await evaluateStepValues(step, { abortSignal: step.config.abortSignal, conversation });
  } catch (error) {
    if (!(error instanceof DefinitionFailedError)) throw error;
    if (isSignInError(error.cause)) return { kind: "sign-in", error: error.cause };
    return { kind: "failed", result: await failTurn(step, error, "REACTION_FAILED") };
  } finally {
    step.ctx.delete(SignInCompletedKey);
  }
  return { kind: "ready" };
}

/** What a model call does next: it runs, it handles a value's sign-in, or the turn failed. */
export type ModelCallPreparation =
  | { readonly kind: "ready" }
  | { readonly kind: "sign-in"; readonly error: unknown }
  | { readonly kind: "failed"; readonly result: StepResult };

/** Whether `error` asks for a sign-in, or reports that one failed. */
export function isSignInError(error: unknown): boolean {
  return isScopedAuthorizationRequiredError(error) || isConnectionAuthorizationFailedError(error);
}

/** Reasons eve sets itself. Their messages speak to the model, so the person reads one line. */
const EVE_SIGN_IN_REASONS: ReadonlySet<string | undefined> = new Set([
  SIGN_IN_DECLINED,
  "app_not_installed",
  "principal_required",
  "sign_in_cancelled",
  "sign_in_unavailable",
  "token_rejected_after_authorization",
]);

/**
 * A model call's sign-in didn't finish, so the turn fails with `SIGN_IN_FAILED`. The person reads
 * the provider's name, with the provider's own message when the author's code threw one.
 */
export async function failSignIn(
  step: Step,
  error: unknown,
  signIn: { readonly scope: string; readonly authorization?: Readonly<AuthorizationDefinition> },
): Promise<StepResult> {
  const name = providerName(step.view(), signIn);
  const message =
    isConnectionAuthorizationFailedError(error) && !EVE_SIGN_IN_REASONS.has(error.reason)
      ? `${name}: ${error.message}`
      : `The sign-in to ${name} didn't finish.`;
  return await failTurn(step, error, "SIGN_IN_FAILED", message);
}

/** The provider's display name, from its definition or the session's latest sign-in card. */
function providerName(
  view: SessionView,
  signIn: { readonly scope: string; readonly authorization?: Readonly<AuthorizationDefinition> },
): string {
  const cards = Object.values(view.projection.view.interactions).flatMap(
    (row) => row.request.signIn ?? [],
  );
  const card = cards.findLast((asked) => asked.name === signIn.scope) ?? cards.at(-1);
  const connector = signIn.authorization?.vercelConnect?.connector.split("/").at(-1);
  return (
    signIn.authorization?.displayName ??
    card?.displayName ??
    (connector === undefined ? "the service" : displayProperName(connector))
  );
}

/** A hook failed during the turn: the turn fails. Returns the step's result then. */
export async function failTurnForEffect(step: Step): Promise<StepResult | undefined> {
  const reason = takeTurnFailure(step.ctx as ContextContainer);
  if (reason === undefined) return undefined;
  return failTurn(step, new Error(reason), "HOOK_FAILED");
}

/** The turn fails with `error` and shows `message`; the session waits for its next message. */
async function failTurn(
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

/** A lifecycle event failed to publish: a dynamic model selection failure ends the session. */
export async function failBoundaryEvent(step: Step, error: unknown): Promise<StepResult> {
  throwIfTurnAborted(step.config.abortSignal);
  if (isDynamicModelSelectionError(error)) return failModelSelection(step, error);
  throw error;
}

/** No model can serve the turn: the session fails. */
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
