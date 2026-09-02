import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  getPendingInputBatches,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import { isSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import type { HarnessSession } from "#harness/types.js";

const SESSION_LIMIT_BATCH_INVARIANT_MESSAGE =
  "Session-limit pending input batches must contain only session-limit requests.";

/** Returns whether this is a valid session-limit batch and rejects mixed ownership. */
export function isSessionLimitInputBatch(batch: PendingInputBatch): boolean {
  const hasSessionLimit = batch.requests.some((request) => request.kind === "session-limit");
  if (hasSessionLimit && batch.requests.some((request) => request.kind !== "session-limit")) {
    throw new TypeError(SESSION_LIMIT_BATCH_INVARIANT_MESSAGE);
  }
  return hasSessionLimit;
}

/** Drops only harness-authored session-limit prompts from a parked session. */
export function clearPendingSessionLimitPrompt(session: HarnessSession): HarnessSession {
  const dropped = getPendingInputBatches(session.state).filter(
    (batch) =>
      batch.requests.length > 0 &&
      batch.requests.every((request) => isSessionLimitContinuationRequest(request)),
  );
  if (dropped.length === 0) {
    return session;
  }
  return removePendingInputBatches(session, dropped);
}
