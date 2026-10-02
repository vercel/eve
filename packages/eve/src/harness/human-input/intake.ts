import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import { getPendingAuthorization, setPendingAuthorization } from "#harness/authorization.js";
import { hasTailApprovalResponse } from "#harness/current-messages.js";
import { advanceStep } from "#harness/emission.js";
import {
  getPendingInputRequestIds,
  hasStepInput,
  type ResolvedInputBatch,
  resolvePendingInput,
  selectApprovalReplayBatch,
} from "#harness/input-requests.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import {
  getPendingInputBatches,
  type PendingInputBatchEvent,
  queueDeferredStepInput,
} from "#harness/pending-input-batches.js";
import type { Step } from "#harness/step/context.js";
import type { RuntimeWork } from "#harness/step/intake.js";
import type { HarnessToolMap, StepInput, StepResult } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";
import {
  createApprovalCandidateEvent,
  createApprovalSettledEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createActionResultEvent,
  createInputResolvedEvent,
  createMessageCompletedEvent,
  createStepStartedEvent,
  createTurnWaitingEvent,
} from "#protocol/message.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import {
  getApprovalAuditState,
  markApprovalCandidateHistoryEventEmitted,
  markApprovalCandidatePendingEventEmitted,
  markApprovalSettlementEventEmitted,
} from "./candidates.js";
import { coordinateApprovalDelivery } from "./coordinator.js";
import { declinedSignInEvents, withdrawHeldSignIns } from "./held-requests.js";
import {
  convertStaleResponsesToUserMessage,
  dropStaleSessionLimitContinuationResponses,
} from "./stale-responses.js";

/**
 * What a delivery does before its turn runs. `stop` ends the step: the answers left nothing to run
 * yet, or the turn holds for a responder's sign-in. `run` carries the turn's input and what the
 * answers resolved.
 */
export type HumanInputIntake =
  | { readonly kind: "stop"; readonly result: StepResult }
  | {
      readonly kind: "run";
      /** The turn's input, with stale answers as text and a note on sign-ins steering ended. */
      readonly input: StepInput | undefined;
      /** The message the turn receives, as the stream shows it. */
      readonly message?: StepInput["message"];
      /** The transcript the answers completed, which the step resumes after the preamble. */
      readonly pending: readonly HarnessModelMessage[];
      /** A plain-text answer consumed the message, so the model never reads it. */
      readonly consumedMessage: boolean;
      /** An approved call runs first, so the turn's context and message wait for a later step. */
      readonly deferredContext: boolean;
      readonly deferredMessage: boolean;
      /** The delivery carries input for a turn. */
      readonly opensTurn: boolean;
      readonly approved: ApprovedWork;
    };

/** What the delivery's answers resolved: approvals, and the answer to a budget prompt. */
export interface ApprovedWork {
  readonly resolved: readonly ResolvedInputBatch[];
  readonly limit?: { readonly granted: boolean };
}

const STEERED_SIGN_IN_REASON = "Cancelled because a new message arrived.";

/**
 * Takes the delivery's answers to what the session asked. Approval answers pass the response
 * policies before they resolve the step they answer. A new message steers the held turn past the
 * sign-ins it waits on. `delivered` is the delivery as it arrived, `runtime` the step's input and
 * history once the runtime's results settled.
 */
export async function acceptHumanInput(
  step: Step,
  delivered: StepInput | undefined,
  runtime: RuntimeWork,
): Promise<HumanInputIntake> {
  const { config } = step;
  // Stale responses take two passes: drop what must never reach the model (session-limit
  // continuation answers), then convert what should reach it as plain text.
  const pendingRequestIds = getPendingInputRequestIds(step.session.state);
  const stale = convertStaleResponsesToUserMessage({
    history: runtime.messages,
    pendingRequestIds,
    stepInput: dropStaleSessionLimitContinuationResponses({
      pendingRequestIds,
      stepInput: runtime.input,
    }),
  });
  let input = stale.stepInput;
  // A new message reaching an open turn steers it: the turn moves past the sign-ins it waits on,
  // and its unanswered approvals resolve below.
  if (delivered?.message !== undefined || stale.kind === "converted") {
    input = await withdrawSteeredSignIns(step, input);
  }
  const message = stale.kind === "converted" ? stale.displayMessage : input?.message;

  // Restoring an approval's tools resolves the asking turn's dynamic tools.
  const restoreTools = async (
    batch: { readonly event?: PendingInputBatchEvent } | undefined,
  ): Promise<HarnessToolMap> => {
    if (batch?.event !== undefined) await config.prepareApprovalTurn?.(batch.event);
    if (step.ctx !== undefined) {
      await config.resolveStepDynamicTools?.({
        ctx: step.ctx,
        event: createStepStartedEvent({
          modelId: step.session.agent.modelReference?.id ?? "dynamic",
          ...(batch?.event ?? step.position()),
        }),
        messages: step.projectHistory(runtime.messages),
      });
    }
    return buildResponseAuthorizationTools({ authoredTools: config.tools, context: step.ctx });
  };
  const pendingChallenges = getPendingAuthorization(step.session.state)?.challenges ?? [];
  const coordinated = await coordinateApprovalDelivery({
    prepareTools: async (request) =>
      await restoreTools(
        getPendingInputBatches(step.session.state).find((batch) =>
          batch.requests.some((entry) => entry.requestId === request.requestId),
        ),
      ),
    session: step.session,
    stepInput: input,
    tools: config.tools,
  });
  step.session = coordinated.session;
  await reportApprovalProgress(step, pendingChallenges, coordinated.feedback);
  if (coordinated.kind === "park") return stop({ next: null, session: step.session });
  if (coordinated.kind === "continue-coordination") {
    if (coordinated.stepInput !== undefined) {
      step.session = queueDeferredStepInput(step.session, coordinated.stepInput);
    }
    return stop({ next: step.runStep, session: step.session });
  }
  if (coordinated.challenges.length > 0) {
    // A responder's sign-in for the turn's approval holds the turn.
    const { challenges } = coordinated;
    for (const challenge of challenges) {
      await step.emit?.(
        createAuthorizationRequiredEvent({
          ...authorizationEventFields(challenge),
          ...coordinates(step),
          description:
            challenge.challenge.instructions ?? `Authorization required for ${challenge.name}`,
          webhookUrl: challenge.hookUrl,
        }),
      );
    }
    await holdForInput(step);
    if (coordinated.stepInput !== undefined) {
      step.session = queueDeferredStepInput(step.session, coordinated.stepInput);
    }
    step.session = {
      ...step.session,
      state: setPendingAuthorization(step.session.state, { challenges }),
    };
    return stop({ held: { kind: "request" }, next: null, session: step.session });
  }

  // Approved siblings of a finished workflow run with their approval turn's tools.
  const replayBatch =
    runtime.resumed !== undefined && hasTailApprovalResponse(runtime.messages)
      ? runtime.resumed
      : selectApprovalReplayBatch(step.session, coordinated.stepInput);
  const responseTools = replayBatch === undefined ? config.tools : await restoreTools(replayBatch);
  const pending = resolvePendingInput({
    history: runtime.messages,
    resolveApprovalKey: approvalKeyResolver(responseTools),
    session: step.session,
    stepInput: coordinated.stepInput,
  });
  if (pending.outcome === "unresolved") {
    // The runtime's results commit before the still-pending approvals park.
    step.session =
      runtime.resumed === undefined
        ? pending.session
        : { ...pending.session, history: validateHarnessModelMessages(runtime.messages) };
    // The turn's request is still open (a partial answer, a refused responder, or a message
    // waiting behind a budget prompt), so the turn stays held.
    await holdForInput(step);
    return stop({ held: { kind: "request" }, next: null, session: step.session });
  }

  await reportResolvedInput(step, pending);
  step.session = pending.session;
  return {
    approved: { limit: pending.limitContinuation, resolved: pending.resolvedInputs ?? [] },
    consumedMessage: pending.consumedMessage === true,
    deferredContext: pending.deferredContext === true,
    deferredMessage: pending.deferredMessage === true,
    input,
    kind: "run",
    // A deferred message replays on a later step, which announces it then.
    message: pending.deferredMessage === true ? undefined : message,
    opensTurn: hasStepInput(input) || hasStepInput(coordinated.stepInput),
    pending: validateHarnessModelMessages(pending.messages.slice(step.session.history.length)),
  };
}

/** A sign-in or tool approval the turn raised holds it open, like a task or `ctx.ask` does. */
export async function holdForInput(step: Step, from = step.position()): Promise<void> {
  if (step.emit === undefined) return;
  const next = advanceStep(from);
  await step.emit(
    createTurnWaitingEvent({
      on: "input",
      sequence: next.sequence,
      turnId: next.turnId,
      usage: getSessionUsage(step.session),
    }),
  );
  step.moveTo(next);
}

/** Resolves the key a `once()` approval grants, from the tools of the turn that asked. */
export function approvalKeyResolver(
  tools: HarnessToolMap,
): (request: InputRequest) => string | undefined {
  return (request) => tools.get(request.action.toolName)?.approvalKey?.(request.action.input);
}

function stop(result: StepResult): HumanInputIntake {
  return { kind: "stop", result };
}

function coordinates(step: Step) {
  const { sequence, stepIndex, turnId } = step.position();
  return { sequence, stepIndex, turnId };
}

/** The sign-ins a steered turn waits on end, and the model learns why. */
async function withdrawSteeredSignIns(
  step: Step,
  input: StepInput | undefined,
): Promise<StepInput | undefined> {
  const withdrawal = withdrawHeldSignIns(step.session.state, {
    completedAt: Date.now(),
    reason: STEERED_SIGN_IN_REASON,
  });
  step.session = { ...step.session, state: withdrawal.state };
  if (withdrawal.withdrawn.length === 0) return input;
  if (step.emit !== undefined) {
    for (const event of declinedSignInEvents(
      withdrawal.withdrawn,
      STEERED_SIGN_IN_REASON,
      step.position(),
    )) {
      await step.emit(event);
    }
  }
  const names = [...new Set(withdrawal.withdrawn.map((challenge) => challenge.name))];
  return {
    ...input,
    context: [
      ...(input?.context ?? []),
      `Sign-in to ${names.join(", ")} was cancelled because the user sent a new message instead. Ask to sign in again only if the new message still needs it.`,
    ],
  };
}

/**
 * Reports what the response policies decided: their feedback, expired responder sign-ins, and each
 * candidate's and settlement's progress, each once.
 */
async function reportApprovalProgress(
  step: Step,
  pendingChallenges: NonNullable<ReturnType<typeof getPendingAuthorization>>["challenges"],
  feedback: readonly string[],
): Promise<void> {
  const { emit } = step;
  if (emit === undefined) return;
  const at = coordinates(step);
  for (const message of feedback) {
    await emit(createMessageCompletedEvent({ message, ...at }));
  }
  const audit = getApprovalAuditState(step.session.state);
  for (const challenge of pendingChallenges) {
    const expired = audit.candidateHistory.some(
      (candidate) =>
        candidate.candidateId === challenge.candidateId &&
        candidate.status === "timed-out" &&
        candidate.eventEmitted !== true,
    );
    if (!expired) continue;
    await emit(
      createAuthorizationCompletedEvent({
        ...authorizationEventFields(challenge),
        ...at,
        outcome: "failed",
        reason: "The approval response expired. Please submit a new response.",
      }),
    );
  }
  for (const candidate of audit.activeCandidates) {
    if (candidate.pendingEventEmitted === true) continue;
    await emit(
      createApprovalCandidateEvent({
        ...at,
        candidateId: candidate.candidateId,
        outcome: "pending",
        requestId: candidate.requestId,
        responderPrincipalId: candidate.responder.principalId,
      }),
    );
    step.session = {
      ...step.session,
      state: markApprovalCandidatePendingEventEmitted({
        candidateId: candidate.candidateId,
        state: step.session.state,
      }),
    };
  }
  for (const candidate of audit.candidateHistory) {
    if (candidate.eventEmitted === true || candidate.status === "allowed") continue;
    await emit(
      createApprovalCandidateEvent({
        ...at,
        candidateId: candidate.candidateId,
        outcome: candidate.status as Exclude<
          typeof candidate.status,
          "allowed" | "authorization-required"
        >,
        reason: candidate.reason,
        requestId: candidate.requestId,
        responderPrincipalId: candidate.responder.principalId,
      }),
    );
    step.session = {
      ...step.session,
      state: markApprovalCandidateHistoryEventEmitted({
        candidateId: candidate.candidateId,
        state: step.session.state,
      }),
    };
  }
  for (const settlement of audit.settlements) {
    if (settlement.eventEmitted === true) continue;
    await emit(
      createApprovalSettledEvent({
        ...at,
        outcome: settlement.outcome === "allowed" ? "approved" : "cancelled",
        requestId: settlement.requestId,
        responderPrincipalId: settlement.actor.principalId,
      }),
    );
    step.session = {
      ...step.session,
      state: markApprovalSettlementEventEmitted({
        requestId: settlement.requestId,
        state: step.session.state,
      }),
    };
  }
}

/** Reports what the answers resolved, at the step that asked, and the calls they denied. */
async function reportResolvedInput(
  step: Step,
  pending: Pick<ReturnType<typeof resolvePendingInput>, "rejectedActions" | "resolvedInputs">,
): Promise<void> {
  for (const batch of pending.resolvedInputs ?? []) {
    await step.instrumentation?.publishInputResolutions({
      batch,
      sessionId: step.session.sessionId,
    });
    await step.emit?.(
      createInputResolvedEvent({
        resolutions: batch.inputs.map((resolved) => {
          const resolution = {
            kind: resolved.request.kind,
            outcome: resolved.outcome,
            requestId: resolved.request.requestId,
          };
          if (resolved.response === undefined) return resolution;
          return { ...resolution, response: resolved.response };
        }),
        sequence: batch.event.sequence,
        stepIndex: batch.event.stepIndex,
        turnId: batch.event.turnId,
      }),
    );
  }
  // A denial otherwise lives only in model history, so consumers would never see the call
  // resolve: it reports as a rejected `action.result` at the turn that asked.
  for (const rejected of pending.rejectedActions ?? []) {
    for (const result of rejected.results) {
      await step.emit?.(
        createActionResultEvent({
          rejected: true,
          result,
          sequence: rejected.event.sequence,
          stepIndex: rejected.event.stepIndex,
          turnId: rejected.event.turnId,
        }),
      );
    }
  }
}
