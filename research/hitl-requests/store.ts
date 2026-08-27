/**
 * Consistent storage for the request ledger.
 *
 * Today HITL state rides in workflow step results: the whole SessionStateMap
 * (pending batches, pendingAuthorization, approval audit state, withheld
 * responseMessages) is re-serialized into every DurableSessionSnapshot —
 * "Workflow step results are the atomic persistence boundary for session
 * program memory" (durable-session-store.ts). That gives free atomicity and
 * costs everything else: no read path without hydrating a run, full-snapshot
 * rewrite per step, and unbounded journal growth from the withheld blobs.
 *
 * The store replaces WHERE the ledger persists, not WHO decides:
 *
 *   writes  only the interpreter pass, still serialized through the owner's
 *           inbox — one writer per scope, arrival order unchanged
 *           (#1224 invariant 5). HTTP routes and channels never write.
 *   reads   anyone: channels list open requests without hydrating a run;
 *           the task-input route validates a capability token against a
 *           live row; input_required task views derive from open rows.
 *
 * Same shape as MemoryDocumentBackend (public/memory/file/backend.ts):
 * read / conditional write / conflict error. Default backend via nitro
 * (db0 locally, the deployment's database in production); the interface is
 * eve-owned so a World or user supplies another.
 *
 * Crash consistency without step-result atomicity: interpretation is
 * deterministic over (ledger version, deliveryId). The step does
 * read → interpret → write(CAS) → perform effects; a crash after the write
 * retries the step, the CAS conflicts, the re-read interprets the same
 * delivery against the new version, and deliveryId hits tombstones and
 * held-candidate dedupe — same effects re-derived, performed once.
 * "State before effects" (#1224 invariant 8) is preserved verbatim; it
 * points at the store instead of the snapshot.
 */

import type { Ledger, Row } from "./types.js";

/**
 * Root session id. Body-run rows live under their root session's scope —
 * the parent projection reads them — never under the run's own id.
 */
export type LedgerScope = string;

export interface VersionedLedger {
  readonly ledger: Ledger;
  /** Opaque backend version used for optimistic writes. */
  readonly version: string;
}

/**
 * The store holds rows, groups, and held candidates ONLY. A group's
 * continuation payload (the withheld model output — the big blobs) is a
 * separate record written once at park and read once at claim, so the hot
 * read path never drags model output.
 */
export interface RequestLedgerStore {
  read(scope: LedgerScope): Promise<VersionedLedger | null>;
  /** CAS: `expectedVersion: null` is create-only; a stale version throws. */
  write(
    scope: LedgerScope,
    ledger: Ledger,
    expectedVersion: string | null,
  ): Promise<VersionedLedger>;
}

/** Raised when the ledger changed between read and conditional write. */
export class LedgerConflictError extends Error {
  constructor(readonly scope: LedgerScope) {
    super(`Request ledger for "${scope}" changed before it could be updated.`);
    this.name = "LedgerConflictError";
  }
}

/** Derived reads are pure functions over the ledger — not store methods. */
export function openRows(ledger: Ledger): readonly Row[] {
  return ledger.rows.filter((row) => row.state.phase === "open");
}
