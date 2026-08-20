import type { SubagentInputRequestEvent } from "#channel/types.js";
import { getPendingAuthorization } from "#harness/authorization.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";

/** Returns only the input batch created by the active turn, never an older parked batch. */
export function deriveCurrentTurnInputRequest(
  session: HarnessSession,
  turnId: string,
): SubagentInputRequestEvent | undefined {
  const batch = getPendingInputBatches(session.state).find(
    (candidate) => candidate.event?.turnId === turnId,
  );
  if (batch?.event === undefined) return undefined;
  return { ...batch.event, requests: batch.requests };
}

/** Derives the pending-state fields needed to choose the next driver action. */
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
  if (batch !== undefined) {
    return {
      ...base,
      pendingRuntimeActionKeys: batch.actions.map((action) => getRuntimeActionRequestKey(action)),
    };
  }
  return base;
}
