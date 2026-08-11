import type { PendingInputBatch } from "#harness/pending-input-batches.js";
import {
  getPendingInputBatches,
  queueDeferredStepInput,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import {
  appendResolvedBatchTranscript,
  compactStepInput,
  finishResolvedInput,
  responsesForBatches,
} from "#harness/hitl/pending-input-resolution.js";
import type {
  InputDomainResolverInput,
  ResolvePendingInputResult,
} from "#harness/hitl/pending-input-resolution.js";
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

export function resolveSessionLimitInput(
  input: InputDomainResolverInput & { readonly pendingBatch: PendingInputBatch },
): ResolvePendingInputResult {
  const responseIds = new Set(input.responses.map((response) => response.requestId));
  const answered =
    input.pendingBatch.requests.some((request) => responseIds.has(request.requestId)) &&
    input.pendingBatch.requests.every((request) => responseIds.has(request.requestId));
  if (!answered) {
    return {
      deferredMessage: true,
      outcome: "unresolved",
      messages: [...input.baseHistory],
      session: queueDeferredStepInput(input.session, compactStepInput(input.resolvedStepInput)),
    };
  }

  const openBatches = input.batches.filter((batch) => batch !== input.pendingBatch);
  const leftoverResponses = responsesForBatches(input.responses, openBatches);
  const limitBlocked = openBatches.some((batch) =>
    batch.requests.some((request) => isSessionLimitContinuationRequest(request)),
  );
  const messages = [...input.baseHistory];
  appendResolvedBatchTranscript(messages, input.pendingBatch, []);
  const session = removePendingInputBatches(input.session, [input.pendingBatch]);
  const limitContinuation = resolveSessionLimitContinuation({
    requests: input.pendingBatch.requests,
    responses: input.responses,
  });

  return finishResolvedInput({
    deferTurnInput: input.deferTurnInput || limitBlocked,
    leftoverResponses,
    limitContinuation,
    messages,
    resolvedStepInput: input.resolvedStepInput,
    session,
  });
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
