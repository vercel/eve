import { getPendingAuthorization } from "#harness/authorization.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";

/** Projects the pending fields consumed by the turn workflow at a park boundary. */
export function derivePendingState(session: HarnessSession): {
  readonly authorizationAttemptIds?: readonly string[];
  readonly authorizationNames?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasPendingInputBatch: boolean;
  readonly pendingRuntimeActionKeys?: readonly string[];
} {
  const batch = getPendingRuntimeActionBatch(session.state);
  const pendingAuth = getPendingAuthorization(session.state);
  const base = {
    authorizationAttemptIds: pendingAuth?.challenges.flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
    authorizationNames: pendingAuth?.challenges.map((challenge) => challenge.name),
    hasPendingAuthorization: pendingAuth !== undefined,
    hasPendingInputBatch: hasPendingInputBatch(session.state),
  };
  return batch === undefined
    ? base
    : {
        ...base,
        pendingRuntimeActionKeys: batch.actions.map(getRuntimeActionRequestKey),
      };
}
