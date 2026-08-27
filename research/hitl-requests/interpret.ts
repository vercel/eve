/**
 * Prototype: HITL request interpreter.
 *
 * Companion to ../hitl-requests.md. Not wired into the build; typed
 * against the real harness shapes (`PendingInputBatch`, `InputRequest`,
 * `InputResponse`, `ResolvePendingInputResult`) so every claim in the doc is
 * checkable against the code it must replace. See ledger.ts for how interpreter
 * state derives from the EXISTING batch state without a new store, and
 * seam.ts for where this runs in the step loop (unchanged: between steps).
 */

import type { InputResponse } from "./harness-types.js";
import type {
  Ledger,
  LedgerEffect,
  Row,
  RowInput,
  RowRef,
  Verdict,
  VariantRegistry,
} from "./types.js";

/**
 * One interpreter pass: interpret one delivery against the ledger.
 *
 * Owns everything variant-agnostic, in order:
 *   1. staleness — responses naming terminal rows reject before any reducer
 *   2. candidate identity — single winner per row per pass
 *   3. reducer dispatch — one variant, one row, one verdict
 *   4. verdict application — settle / reject / dismiss / blockOn bookkeeping
 *   5. group closure — continuation claim exactly once, all members terminal
 *
 * The caller persists `ledger` before performing `effects` (state before
 * effects). Reducers may be async (authored policies); the interpreter awaits
 * them sequentially in row order so replay is journal-deterministic.
 */
export async function interpretDelivery(input: {
  readonly ledger: Ledger;
  /**
   * Server-assigned admission id for this delivery. Candidate identity is
   * {requestId, deliveryId}: a workflow-level redelivery reuses it (held
   * candidates dedupe on it); a new delivery is a new candidate.
   */
  readonly deliveryId: string;
  readonly responses: readonly InputResponse[];
  readonly message: { readonly actor: "originating" | "other" | "anonymous" } | undefined;
  /** Connection-authorization callbacks and fired deadlines, arrival-ordered. */
  readonly callbacks?: readonly { readonly rowId: string; readonly params: Record<string, unknown> }[];
  readonly deadlines?: readonly { readonly rowId: string }[];
  readonly variants: VariantRegistry;
}): Promise<{ ledger: Ledger; effects: LedgerEffect[] }> {
  let ledger = input.ledger;
  const effects: LedgerEffect[] = [];

  // 1+2. Responses: staleness, then per-row dispatch. One response per
  // request id per delivery (canonicalized upstream, as today).
  for (const response of input.responses) {
    const row = ledger.rows.find((candidate) => candidate.id === response.requestId);

    if (row === undefined) {
      // Unknown id: malformed, never raised. #1224 reason "invalid".
      effects.push({ kind: "reject-response", reason: "invalid", response, visibility: "context-turn" });
      continue;
    }
    if (row.state.phase !== "open") {
      // Tombstone: single-winner already decided. Visibility is the
      // variant's one modulation (staleResponses).
      const visibility = input.variants[row.kind].staleResponses ?? "context-turn";
      effects.push({ kind: "reject-response", reason: "stale", response, visibility });
      continue;
    }
    // Redelivery of a delivery whose candidate is already held on a
    // challenge: return the existing pending candidate, never a second
    // challenge (owner.approval.response.pend-authorization dedupe).
    const held = ledger.heldCandidates.find(
      (candidate) => candidate.rowId === row.id && candidate.deliveryId === input.deliveryId,
    );
    if (held !== undefined) continue;

    const verdict = await input.variants[row.kind].resolve(row, {
      kind: "response",
      response,
      responder: response.responder ?? null,
      actor: response.actor ?? "anonymous",
    });
    ({ ledger } = applyVerdict({ ledger, row, verdict, effects, response, deliveryId: input.deliveryId }));
  }

  // Callbacks and deadlines dispatch to their challenge rows, then any row
  // that was blocked on a newly terminal linked row is re-fed in the SAME
  // pass (pend-authorization: authorized → re-run the authorizer without
  // a further external delivery).
  for (const callback of input.callbacks ?? []) {
    ledger = await dispatchToRow(ledger, callback.rowId, { kind: "callback", params: callback.params }, input.variants, effects);
  }
  for (const deadline of input.deadlines ?? []) {
    ledger = await dispatchToRow(ledger, deadline.rowId, { kind: "deadline" }, input.variants, effects);
  }
  ledger = await refeedUnblockedCandidates(ledger, input.variants, effects);

  // 3. Message observation: broadcast to every open row. Variants answer
  // independently; mixed batches (owner.batch.message.dismiss-question-only)
  // fall out of per-row dispatch with no batch-level case.
  if (input.message !== undefined) {
    let consumed = false;
    for (const row of [...ledger.rows]) {
      if (row.state.phase !== "open") continue;
      const verdict = await input.variants[row.kind].resolve(row, {
        kind: "message",
        actor: input.message.actor,
      });
      if (verdict === "ignore") continue;
      // At most one consumer per delivery, deterministic by row order.
      if (typeof verdict === "object" && "dismiss" in verdict && verdict.consumeDelivery === true) {
        if (consumed) continue;
        consumed = true;
      }
      ({ ledger } = applyVerdict({ ledger, row, verdict, effects }));
    }
    if (consumed) effects.push({ kind: "consume-message" });
  }

  // 4. Group closure: a group whose members are all terminal claims its
  // continuation exactly once. Forced closure (cancel/session-end) goes
  // through closeForced instead and suppresses it.
  ledger = claimClosedGroups(ledger, effects);

  return { ledger, effects };
}

/** Dispatches one input to one open row and applies the verdict. */
async function dispatchToRow(
  ledger: Ledger,
  rowId: string,
  rowInput: { readonly kind: "callback"; readonly params: Record<string, unknown> } | { readonly kind: "deadline" },
  variants: VariantRegistry,
  effects: LedgerEffect[],
): Promise<Ledger> {
  const row = ledger.rows.find((candidate) => candidate.id === rowId);
  // A callback after completion, or with no matching challenge, is rejected
  // stale — never silently queued (owner.auth.callback.reject-stale).
  if (row === undefined || row.state.phase !== "open") {
    effects.push({ kind: "reject-response", reason: "stale", response: undefined, visibility: "context-turn" });
    return ledger;
  }
  const verdict = await variants[row.kind].resolve(row, rowInput);
  return applyVerdict({ ledger, row, verdict, effects }).ledger;
}

/**
 * Re-feeds every row whose held candidate's linked row reached terminal
 * state in this pass, with the linked outcome as data. The blocking variant
 * re-adjudicates (pend-authorization: authorized re-runs the authorizer;
 * declined → unauthorized; failed/timed-out → policy-failed).
 */
async function refeedUnblockedCandidates(
  input: Ledger,
  variants: VariantRegistry,
  effects: LedgerEffect[],
): Promise<Ledger> {
  let ledger = input;
  for (const held of [...ledger.heldCandidates]) {
    const linked = ledger.rows.find((row) => row.id === held.linkedRowId);
    if (linked === undefined || linked.state.phase === "open") continue;
    const row = ledger.rows.find((candidate) => candidate.id === held.rowId);
    ledger = { ...ledger, heldCandidates: ledger.heldCandidates.filter((c) => c !== held) };
    if (row === undefined || row.state.phase !== "open") continue;
    const outcome =
      linked.state.phase === "settled" ? String(linked.state.outcome) : "failed";
    const verdict = await variants[row.kind].resolve(row, {
      kind: "linked",
      outcome,
      heldResponse: held.response,
    });
    ({ ledger } = applyVerdict({ ledger, row, verdict, effects, response: held.response, deliveryId: held.deliveryId }));
  }
  return ledger;
}

/** Applies one verdict to one row. The only writer of row phases. */
function applyVerdict(input: {
  readonly ledger: Ledger;
  readonly row: Row;
  readonly verdict: Verdict;
  readonly effects: LedgerEffect[];
  readonly response?: InputResponse;
  readonly deliveryId?: string;
}): { ledger: Ledger } {
  const { row, verdict, effects } = input;
  let ledger = input.ledger;

  if (verdict === "ignore") return { ledger };

  if ("settle" in verdict) {
    ledger = setRowPhase(ledger, row.id, { phase: "settled", outcome: verdict.settle });
    effects.push({ kind: "settled", rowId: row.id, outcome: verdict.settle });
    // A row settling while it holds a blocked candidate cancels the linked
    // row and rejects the held candidate (settle-cancel-pending-candidate).
    const held = ledger.heldCandidates.find((candidate) => candidate.rowId === row.id);
    if (held !== undefined) {
      ledger = setRowPhase(ledger, held.linkedRowId, { phase: "settled", outcome: "cancelled" });
      ledger = { ...ledger, heldCandidates: ledger.heldCandidates.filter((c) => c !== held) };
      effects.push({ kind: "reject-response", reason: "candidate-cancelled", response: held.response, visibility: "context-turn" });
    }
    return { ledger };
  }

  if ("reject" in verdict) {
    effects.push({
      kind: "reject-response",
      reason: verdict.reject,
      response: input.response,
      visibility: "context-turn",
    });
    return { ledger }; // row stays open — rejection never settles
  }

  if ("dismiss" in verdict) {
    ledger = setRowPhase(ledger, row.id, { phase: "dismissed", reason: verdict.dismiss });
    effects.push({ kind: "dismissed", rowId: row.id, reason: verdict.dismiss });
    if (verdict.reopen !== undefined) {
      const reopened: Row = {
        ...row,
        id: `${row.baseId}:${row.generation + 1}`,
        generation: row.generation + 1,
        spec: verdict.reopen,
        state: { phase: "open" },
      };
      ledger = { ...ledger, rows: [...ledger.rows, reopened] };
      effects.push({ kind: "opened", rowId: reopened.id });
    }
    return { ledger };
  }

  // blockOn: open the linked challenge row, hold the candidate. The row is
  // re-fed a "linked" input when the linked row reaches terminal — same
  // pass via refeedUnblockedCandidates, or a later one.
  const linked: Row = {
    id: `${row.id}:challenge`,
    baseId: `${row.id}:challenge`,
    generation: 0,
    kind: "challenge",
    spec: verdict.blockOn,
    owner: row.owner,
    groupId: row.groupId,
    state: { phase: "open" },
  };
  effects.push({ kind: "candidate-pending", rowId: row.id, linkedRowId: linked.id });
  return {
    ledger: {
      ...ledger,
      rows: [...ledger.rows, linked],
      heldCandidates: [
        ...ledger.heldCandidates,
        {
          rowId: row.id,
          linkedRowId: linked.id,
          response: input.response!,
          deliveryId: input.deliveryId ?? "",
        },
      ],
    },
  };
}

/**
 * Forced closure: turn cancel or session end. Dismisses every open row owned
 * by the scope, suppresses continuations, cancels held candidates. Uniform —
 * no variant consulted; challenge dismissals translate to
 * `completed(cancelled)` at the event layer.
 */
export function closeForced(input: {
  readonly ledger: Ledger;
  readonly scope: { readonly turnId: string } | "session";
}): { ledger: Ledger; effects: LedgerEffect[] } {
  const effects: LedgerEffect[] = [];
  let ledger = input.ledger;
  for (const row of ledger.rows) {
    if (row.state.phase !== "open") continue;
    if (input.scope !== "session" && row.turnId !== input.scope.turnId) continue;
    const reason = input.scope === "session" ? "session-ended" : "cancelled";
    ledger = setRowPhase(ledger, row.id, { phase: "dismissed", reason });
    effects.push({ kind: "dismissed", rowId: row.id, reason });
  }
  // Groups touched by forced closure suppress instead of claim.
  ledger = {
    ...ledger,
    groups: ledger.groups.map((group) =>
      group.continuation === "pending" && groupIsTerminal(ledger, group.id)
        ? { ...group, continuation: "suppressed" }
        : group,
    ),
    heldCandidates: [],
  };
  return { ledger, effects };
}

/**
 * Intent dedup at raise time (invariant 4): a new row whose variant intent
 * key matches an open row resolves already-pending instead of opening.
 * Cross-owner by design — a body run and a session turn share the check.
 */
export function raiseRows(input: {
  readonly ledger: Ledger;
  readonly rows: readonly Row[];
  readonly variants: VariantRegistry;
}): { ledger: Ledger; alreadyPending: readonly { row: Row; openRef: RowRef }[] } {
  const alreadyPending: { row: Row; openRef: RowRef }[] = [];
  const admitted: Row[] = [];
  for (const row of input.rows) {
    const key = input.variants[row.kind].intentKey?.(row.spec);
    const open =
      key === undefined
        ? undefined
        : input.ledger.rows.find(
            (candidate) =>
              candidate.state.phase === "open" &&
              candidate.kind === row.kind &&
              input.variants[candidate.kind].intentKey?.(candidate.spec) === key,
          );
    if (open !== undefined) {
      alreadyPending.push({ row, openRef: { id: open.id } });
      continue;
    }
    admitted.push(row);
  }
  return {
    ledger: { ...input.ledger, rows: [...input.ledger.rows, ...admitted] },
    alreadyPending,
  };
}

function claimClosedGroups(ledger: Ledger, effects: LedgerEffect[]): Ledger {
  return {
    ...ledger,
    groups: ledger.groups.map((group) => {
      if (group.continuation !== "pending" || !groupIsTerminal(ledger, group.id)) return group;
      effects.push({ kind: "claim-continuation", groupId: group.id });
      return { ...group, continuation: "claimed" };
    }),
  };
}

function groupIsTerminal(ledger: Ledger, groupId: string): boolean {
  return ledger.rows
    .filter((row) => row.groupId === groupId)
    .every((row) => row.state.phase !== "open");
}

function setRowPhase(ledger: Ledger, rowId: string, state: Row["state"]): Ledger {
  return {
    ...ledger,
    rows: ledger.rows.map((row) => (row.id === rowId ? { ...row, state } : row)),
  };
}
