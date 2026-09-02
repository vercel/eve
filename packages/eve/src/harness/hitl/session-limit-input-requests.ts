import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  getPendingInputBatches,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import { appendResolvedBatchTranscript } from "#harness/hitl/pending-input-resolution.js";
import type { RequestVerdict, RequestVerdictReducerInput } from "#harness/hitl/request-verdict.js";
import {
  isSessionLimitContinuationRequest,
  resolveSessionLimitContinuation,
} from "#harness/session-limit-continuation.js";
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

export function hasAnsweredSessionLimitBatch(
  batch: PendingInputBatch,
  responses: RequestVerdictReducerInput["responses"],
): boolean {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return (
    batch.requests.some((request) => responseIds.has(request.requestId)) &&
    batch.requests.every((request) => responseIds.has(request.requestId))
  );
}

export function reduceSessionLimitRequestVerdict(
  input: RequestVerdictReducerInput,
): RequestVerdict & {
  readonly limitContinuation: { readonly granted: boolean };
} {
  const messages = [...input.messages];
  appendResolvedBatchTranscript(messages, input.batch, []);
  const limitContinuation = resolveSessionLimitContinuation({
    requests: input.batch.requests,
    responses: input.responses,
  });
  if (limitContinuation === undefined) {
    throw new TypeError("Answered session-limit batches must resolve a continuation verdict.");
  }

  return {
    limitContinuation,
    messages,
    session: input.session,
  };
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
