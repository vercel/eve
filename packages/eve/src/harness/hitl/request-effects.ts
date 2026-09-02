import type { HarnessEmissionState } from "#harness/emission.js";
import type { RequestEffect } from "#harness/hitl/request-interpreter.js";
import {
  commitRequestLedger,
  readRequestLedger,
  type RequestLedger,
  type RequestRecord,
} from "#harness/hitl/request-ledger.js";
import type { HandleEventFn, HarnessSession } from "#harness/types.js";
import type { InstrumentationStepScope } from "#instrumentation/runtime.js";
import {
  createActionResultEvent,
  createApprovalCandidateEvent,
  createApprovalSettledEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputResolvedEvent,
  createMessageCompletedEvent,
  type ApprovalCandidateOutcome,
} from "#protocol/message.js";

/**
 * Performs the interpreter's ordered effects as protocol events, then marks
 * the emitted approval attempts and settlements on the ledger so a replayed
 * step does not emit them twice. Returns the session with that second commit
 * applied only when something was marked.
 */
export async function performRequestEffects(input: {
  readonly effects: readonly RequestEffect[];
  readonly emissionState: HarnessEmissionState;
  readonly emit: HandleEventFn | undefined;
  readonly session: HarnessSession;
  readonly stepInstrumentation: InstrumentationStepScope<HarnessSession> | undefined;
}): Promise<HarnessSession> {
  const at = {
    sequence: input.emissionState.sequence,
    stepIndex: input.emissionState.stepIndex,
    turnId: input.emissionState.turnId,
  };
  const emittedAttempts = new Set<string>();
  const emittedSettlements = new Set<string>();
  const emittedAuthorizations = new Set<string>();

  for (const effect of input.effects) {
    switch (effect.kind) {
      case "feedback":
        await input.emit?.(createMessageCompletedEvent({ message: effect.message, ...at }));
        break;
      case "approval-attempt":
        await input.emit?.(
          createApprovalCandidateEvent({
            candidateId: effect.attemptId,
            outcome: toCandidateOutcome(effect.status),
            reason: effect.reason,
            requestId: effect.requestId,
            responderPrincipalId: effect.responderPrincipalId,
            ...at,
          }),
        );
        emittedAttempts.add(effect.attemptId);
        break;
      case "approval-settled":
        await input.emit?.(
          createApprovalSettledEvent({
            outcome: effect.outcome,
            requestId: effect.requestId,
            responderPrincipalId: effect.responderPrincipalId,
            ...at,
          }),
        );
        emittedSettlements.add(effect.requestId);
        break;
      case "authorization-required":
        for (const challenge of effect.challenges) {
          await input.emit?.(
            createAuthorizationRequiredEvent({
              attemptId: challenge.attemptId,
              authorization: challenge.challenge,
              candidateId: challenge.candidateId,
              description:
                challenge.challenge.instructions ?? `Authorization required for ${challenge.name}`,
              name: challenge.name,
              webhookUrl: challenge.hookUrl,
              ...at,
            }),
          );
        }
        break;
      case "authorization-completed": {
        const record = readRequestLedger(input.session.state).requests.find(
          (candidate) => candidate.id === effect.requestId,
        );
        if (record?.request.kind === "authorization") {
          await input.emit?.(
            createAuthorizationCompletedEvent({
              attemptId: record.request.authorization.attemptId,
              authorization: record.request.authorization.challenge,
              candidateId: record.request.responseAttemptId,
              name: record.request.authorization.name,
              outcome: effect.outcome === "completed" ? "authorized" : "failed",
              reason: effect.reason,
              ...at,
            }),
          );
        }
        emittedAuthorizations.add(effect.requestId);
        break;
      }
      case "input-resolved":
        await input.stepInstrumentation?.publishInputResolutions({
          batch: { event: effect.group, inputs: effect.resolutions },
          sessionId: input.session.sessionId,
        });
        await input.emit?.(
          createInputResolvedEvent({
            resolutions: effect.resolutions.map((resolved) => {
              const resolution = {
                kind: resolved.request.kind,
                outcome: resolved.outcome,
                requestId: resolved.request.requestId,
              };
              return resolved.response === undefined
                ? resolution
                : { ...resolution, response: resolved.response };
            }),
            sequence: effect.group.sequence,
            stepIndex: effect.group.stepIndex,
            turnId: effect.group.turnId,
          }),
        );
        break;
      case "action-rejected":
        for (const result of effect.results) {
          await input.emit?.(
            createActionResultEvent({
              rejected: true,
              result,
              sequence: effect.group.sequence,
              stepIndex: effect.group.stepIndex,
              turnId: effect.group.turnId,
            }),
          );
        }
        break;
      default: {
        const unhandled: never = effect;
        throw new TypeError(`Unhandled request effect: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  if (
    emittedAttempts.size === 0 &&
    emittedSettlements.size === 0 &&
    emittedAuthorizations.size === 0
  ) {
    return input.session;
  }
  const ledger = readRequestLedger(input.session.state);
  return commitRequestLedger(
    input.session,
    markEmitted(ledger, emittedAttempts, emittedSettlements, emittedAuthorizations),
    ledger.version,
  );
}

function toCandidateOutcome(
  status: Extract<RequestEffect, { kind: "approval-attempt" }>["status"],
): ApprovalCandidateOutcome {
  switch (status) {
    case "pending":
    case "rejected":
    case "failed":
    case "timed-out":
    case "stale":
      return status;
    case "allowed":
      return "pending";
    case "cancelled":
      return "stale";
    default: {
      const unhandled: never = status;
      throw new TypeError(`Unhandled attempt status: ${String(unhandled)}`);
    }
  }
}

function markEmitted(
  ledger: RequestLedger,
  attempts: ReadonlySet<string>,
  settlements: ReadonlySet<string>,
  authorizations: ReadonlySet<string>,
): RequestLedger {
  const requests = ledger.requests.map((record): RequestRecord => {
    const emitted = settlements.has(record.id) || authorizations.has(record.id);
    return {
      ...record,
      attemptHistory: record.attemptHistory?.map((attempt) =>
        attempts.has(attempt.id) ? { ...attempt, eventEmitted: true } : attempt,
      ),
      attempts: record.attempts?.map((attempt) =>
        attempts.has(attempt.id) ? { ...attempt, pendingEventEmitted: true } : attempt,
      ),
      outcomeEventEmitted: emitted ? true : record.outcomeEventEmitted,
    };
  });
  return { ...ledger, requests };
}
