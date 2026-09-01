import { getPendingAuthorization } from "#harness/authorization.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { HarnessSession } from "#harness/types.js";

/** Derives the workflow fields used to select the next action at the park boundary. */
export function derivePendingState(session: HarnessSession): {
  readonly authorizationAttemptIds?: readonly string[];
  readonly authorizationNames?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasPendingInputBatch: boolean;
  readonly pendingCoordinationCallIds?: readonly string[];
} {
  const batch = getPendingCoordinationBatch(session.state);
  const pendingAuth = getPendingAuthorization(session.state);
  const base = {
    authorizationAttemptIds: pendingAuth?.challenges.flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
    authorizationNames: pendingAuth?.challenges.map((challenge) => challenge.name),
    hasPendingAuthorization: pendingAuth !== undefined,
    hasPendingInputBatch: hasPendingInputBatch(session.state),
  };
  if (batch === undefined) return base;
  return {
    ...base,
    pendingCoordinationCallIds: [...batch.runtimeActions, ...batch.tasks].map(
      (request) => request.callId,
    ),
  };
}
