import type { InputRequest } from "#shared/input.js";
import type { RequestLedger, RequestOutcome } from "#harness/hitl/request-ledger.js";
import {
  commitRequestLedger,
  isOpenRequest,
  openRequestGroups,
  readRequestLedger,
} from "#harness/hitl/request-ledger.js";
import {
  appendResolvedBatchTranscript,
  type ReducerInput,
  type ReducerResult,
} from "#harness/hitl/request-interpreter.js";
import {
  isSessionLimitContinuationRequest,
  resolveSessionLimitContinuation,
} from "#harness/session-limit-continuation.js";
import type { HarnessSession } from "#harness/types.js";

const SESSION_LIMIT_BATCH_INVARIANT_MESSAGE =
  "Session-limit pending input batches must contain only session-limit requests.";

/** Returns whether this is a valid session-limit batch and rejects mixed ownership. */
export function isSessionLimitInputBatch(batch: {
  readonly requests: readonly InputRequest[];
}): boolean {
  const hasSessionLimit = batch.requests.some((request) => request.kind === "session-limit");
  if (hasSessionLimit && batch.requests.some((request) => request.kind !== "session-limit")) {
    throw new TypeError(SESSION_LIMIT_BATCH_INVARIANT_MESSAGE);
  }
  return hasSessionLimit;
}

export function hasAnsweredSessionLimitBatch(
  batch: { readonly requests: readonly InputRequest[] },
  responses: ReducerInput["responses"],
): boolean {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return (
    batch.requests.some((request) => responseIds.has(request.requestId)) &&
    batch.requests.every((request) => responseIds.has(request.requestId))
  );
}

export function reduceSessionLimitRequestVerdict(input: ReducerInput): ReducerResult & {
  readonly limitContinuation: { readonly granted: boolean };
} {
  const messages = [...input.messages];
  appendResolvedBatchTranscript(messages, input.group, []);
  const limitContinuation = resolveSessionLimitContinuation({
    requests: input.group.requests,
    responses: input.responses,
  });
  if (limitContinuation === undefined) {
    throw new TypeError("Answered session-limit batches must resolve a continuation verdict.");
  }

  return {
    limitContinuation,
    messages,
    outcomes: new Map(
      input.records
        .map((record) => [record.id, record.outcome])
        .filter((entry): entry is [string, RequestOutcome] => entry[1] !== undefined),
    ),
  };
}

/** Drops only harness-authored session-limit prompts from a parked session. */
export function clearPendingSessionLimitPrompt(session: HarnessSession): HarnessSession {
  const ledger = readRequestLedger(session.state);
  const dropped = openRequestGroups(session.state).filter(
    (group) =>
      group.requests.length > 0 &&
      group.requests.every((request) => isSessionLimitContinuationRequest(request)),
  );
  if (dropped.length === 0) {
    return session;
  }
  const droppedIds = new Set(dropped.map((group) => group.id));
  const nextLedger: RequestLedger = {
    ...ledger,
    groups: ledger.groups.map((group) =>
      droppedIds.has(group.id) ? { ...group, completion: "cancelled" as const } : group,
    ),
    requests: ledger.requests.map((record) =>
      droppedIds.has(record.groupId ?? "") && isOpenRequest(record)
        ? { ...record, outcome: { kind: "cancelled", at: Date.now() } }
        : record,
    ),
  };
  return commitRequestLedger(session, nextLedger, ledger.version);
}
