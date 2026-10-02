import { finishApprovalCandidate, getApprovalAuditState } from "#harness/human-input/candidates.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import {
  clearPendingAuthorization,
  getPendingAuthorization,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import {
  createAuthorizationCompletedEvent,
  type AuthorizationCompletedStreamEvent,
} from "#protocol/message.js";

/**
 * Ends the sign-ins a held turn waits on when the person moves on, by steering
 * it with a message or cancelling it: the turn's own sign-ins, and the sign-ins
 * of responders still checking one of its approvals, whose candidates end as
 * stale. The approvals themselves resolve with the steering step or the cancel.
 */
export function withdrawHeldSignIns(
  state: Record<string, unknown> | undefined,
  input: { readonly completedAt: number; readonly reason: string },
): {
  readonly state: Record<string, unknown> | undefined;
  readonly withdrawn: readonly AuthorizationChallenge[];
} {
  const withdrawn = getPendingAuthorization(state)?.challenges ?? [];
  let next = withdrawn.length === 0 ? state : clearPendingAuthorization(state);
  for (const candidate of getApprovalAuditState(next).activeCandidates) {
    next = finishApprovalCandidate({
      candidateId: candidate.candidateId,
      completedAt: input.completedAt,
      reason: input.reason,
      state: next,
      status: "stale",
    });
  }
  return { state: next, withdrawn };
}

/** The `authorization.completed` events reporting withdrawn sign-ins as declined. */
export function declinedSignInEvents(
  withdrawn: readonly AuthorizationChallenge[],
  reason: string,
  emissionState: HarnessEmissionState,
): AuthorizationCompletedStreamEvent[] {
  return withdrawn.map((challenge) =>
    createAuthorizationCompletedEvent({
      ...authorizationEventFields(challenge),
      outcome: "declined",
      reason,
      sequence: emissionState.sequence,
      stepIndex: emissionState.stepIndex,
      turnId: emissionState.turnId,
    }),
  );
}
