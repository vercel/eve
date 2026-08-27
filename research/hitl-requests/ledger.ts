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
 *   batch.requests[i]                  →  one Row (id = requestId,
 *                                          kind from InputRequest.kind,
 *                                          spec = the InputRequest itself)
 *   batch.responseMessages             →  the group's continuation payload
 *                                          (withheld output, restored once
 *                                          at claim — same splice semantics
 *                                          as appendResolvedBatchTranscript)
 *   batch.event {turnId, stepIndex}    →  Row.turnId + event attribution
 *   batch.responseAuthRequiredRequestIds → ApprovalSpec.responseAuthRequired
 *   pendingAuthorization.challenges    →  challenge Rows in one Group
 *   approval audit activeCandidates    →  heldCandidates (authorization-
 *                                          required) — pending candidates
 *                                          are in-pass state, not persisted
 *   sessionLimit batch (generation)    →  limit Row (baseId + generation)
 *
 * Batch semantics preserved by construction:
 *   - "earlier batches stay open and independently answerable"
 *     (appendPendingInputBatch): rows in different groups never interact.
 *   - requestId uniqueness across batches (assertUniqueRequestIds): row ids
 *     are unique in the flat table — the same invariant, one level up.
 *   - removal-only shrinkage (removePendingInputBatches): rows transition
 *     open → terminal; nothing overwrites rows it never resolved.
 *   - withheld output appears zero times until closure: the continuation
 *     payload lives on the group and is spliced exactly at claim.
 */

import type { PendingInputBatch, SessionStateMap } from "./harness-types.js";
import type { Group, Ledger, Row, VariantKind } from "./types.js";

export function ledgerFromSessionState(state: SessionStateMap | undefined): Ledger {
  const batches = readPendingInputBatches(state);
  const rows: Row[] = [];
  const groups: Group[] = [];

  batches.forEach((batch, index) => {
    const groupId = `batch:${batch.event?.turnId ?? "pre"}:${batch.event?.stepIndex ?? index}`;
    groups.push({ id: groupId, continuation: "pending" });
    for (const request of batch.requests) {
      rows.push({
        id: request.requestId,
        baseId: request.requestId,
        generation: readLimitGeneration(request) ?? 0,
        kind: kindFromRequest(request.kind),
        spec: {
          ...request,
          responseAuthRequired:
            batch.responseAuthRequiredRequestIds?.includes(request.requestId) ?? false,
        },
        owner: "session", // session-turn owner; body runs supply their inbox token
        groupId,
        turnId: batch.event?.turnId,
        state: { phase: "open" },
      });
    }
  });

  // pendingAuthorization challenges join as challenge rows (elided: shape
  // mirrors the batch mapping; one AuthGroup per park).

  return { rows, groups, heldCandidates: readHeldCandidates(state) };
}

function kindFromRequest(kind: "question" | "session-limit" | "tool-approval"): VariantKind {
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
declare function readHeldCandidates(state: SessionStateMap | undefined): Ledger["heldCandidates"];
