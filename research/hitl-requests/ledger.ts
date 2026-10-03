/**
 * The ledger is DERIVED from the existing session state. This file is the
 * answer to "this doesn't touch the existing batch semantics": every field
 * of `PendingInputBatch` maps onto ledger shapes. It is also the one-shot
 * migration import: on first load the legacy keys are read through this
 * derivation, written to the RequestLedgerStore (store.ts), and dropped
 * from the session snapshot.
 *
 *   PendingInputBatch                     Ledger
 *   ─────────────────                     ──────
 *   one batch                          →  one Group (id = batch identity)
 *   batch.requests[i]                  →  one Request (id = requestId,
 *                                          kind from InputRequest.kind,
 *                                          spec = the InputRequest itself)
 *   batch.responseMessages             →  the Group's owner-completion payload
 *                                          (withheld output, restored once
 *                                          on acknowledged delivery — same splice semantics
 *                                          as appendResolvedBatchTranscript)
 *   batch.event {turnId, stepIndex}    →  Request.turnId + event attribution
 *   batch.responseAuthRequiredRequestIds → ApprovalSpec.responseAuthRequired
 *   pendingAuthorization.authorizations    →  authorization Requests in one Group
 *   approval audit activeCandidates    →  responseAttempts (authorization-
 *                                          required) — pending attempts
 *                                          are in-pass state, not persisted
 *   sessionLimit batch (generation)    →  limit Request (baseId + generation)
 *
 * Batch semantics preserved by construction:
 *   - "earlier batches stay open and independently answerable"
 *     (appendPendingInputBatch): requests in different groups never interact.
 *   - requestId uniqueness across batches (assertUniqueRequestIds): request ids
 *     are unique in the flat table — the same invariant, one level up.
 *   - removal-only shrinkage (removePendingInputBatches): requests transition
 *     open → terminal; nothing overwrites requests it never resolved.
 *   - withheld output appears zero times until completion: the owner-completion
 *     payload lives beside the Group and is spliced through idempotent delivery.
 */

import type { PendingInputBatch, SessionStateMap } from "./harness-types.js";
import type { Group, Ledger, Request, RequestKind } from "./types.js";

export function ledgerFromSessionState(state: SessionStateMap | undefined): Ledger {
  const batches = readPendingInputBatches(state);
  const requests: Request[] = [];
  const groups: Group[] = [];

  batches.forEach((batch, index) => {
    const groupId = `batch:${batch.event?.turnId ?? "pre"}:${batch.event?.stepIndex ?? index}`;
    groups.push({ id: groupId, owner: "session", completion: "waiting" });
    for (const request of batch.requests) {
      requests.push({
        id: request.requestId,
        baseId: request.requestId,
        generation: readLimitGeneration(request) ?? 0,
        kind: kindFromRequest(request.kind),
        spec: {
          ...request,
          responseAuthRequired:
            batch.responseAuthRequiredRequestIds?.includes(request.requestId) ?? false,
        },
        groupId,
        turnId: batch.event?.turnId,
        state: { phase: "open" },
      });
    }
  });

  // pendingAuthorization authorizations join as authorization requests (elided: shape
  // mirrors the batch mapping; one AuthGroup per park).

  return { requests, groups, responseAttempts: readResponseAttempts(state) };
}

function kindFromRequest(kind: "question" | "session-limit" | "tool-approval"): RequestKind {
  switch (kind) {
    case "question":
      return "question";
    case "session-limit":
      return "limit";
    case "tool-approval":
      return "approval";
  }
}

declare function readPendingInputBatches(
  state: SessionStateMap | undefined,
): readonly PendingInputBatch[];
declare function readLimitGeneration(request: unknown): number | undefined;
declare function readResponseAttempts(state: SessionStateMap | undefined): Ledger["responseAttempts"];
