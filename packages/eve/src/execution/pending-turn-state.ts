import { getPendingAuthorization } from "#harness/authorization.js";
import { hasOpenRequests } from "#harness/input-requests.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";

/** Derives the workflow fields used to select the next action at the park boundary. */
export function derivePendingState(session: HarnessSession): {
  readonly authorizationAttemptIds?: readonly string[];
  readonly authorizationNames?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasOpenRequests: boolean;
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
    hasOpenRequests: hasOpenRequests(session.state),
  };
  if (batch === undefined) return base;
  return {
    ...base,
    pendingRuntimeActionKeys: batch.actions.map((action) => getRuntimeActionRequestKey(action)),
  };
}
