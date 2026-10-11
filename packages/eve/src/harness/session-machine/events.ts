import {
  createAuthorizationCompletedEvent,
  createInputResolvedEvent,
  type AuthorizationCompletedStreamEvent,
  type InputResolvedStreamEvent,
} from "#protocol/message.js";
import type { SessionAuthorization, SessionInput } from "#protocol/session-projection.js";

// Lifecycle event builders for transitions. Each closes something the projection shows open,
// at the coordinates the projection recorded for it, so readers attach the close to the open.

/** Reports an open request withdrawn: nobody may answer it anymore. */
export function inputWithdrawn(input: SessionInput): InputResolvedStreamEvent {
  return createInputResolvedEvent({
    resolutions: [
      { kind: input.request.kind, outcome: "cancelled", requestId: input.request.requestId },
    ],
    sequence: input.sequence,
    stepIndex: input.stepIndex,
    turnId: input.turnId,
  });
}

/** Reports an open sign-in withdrawn, as declined: its callback no longer resumes anything. */
export function signInWithdrawn(
  attempt: SessionAuthorization,
  reason: string,
): AuthorizationCompletedStreamEvent {
  return createAuthorizationCompletedEvent({
    attemptId: attempt.attemptId,
    candidateId: attempt.candidateId,
    name: attempt.name,
    outcome: "declined",
    principalId: attempt.principalId,
    reason,
    sequence: attempt.sequence,
    stepIndex: attempt.stepIndex,
    taskId: attempt.taskId,
    turnId: attempt.turnId,
  });
}
