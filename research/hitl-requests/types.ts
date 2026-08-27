/**
 * Prototype types. `Row` answers "why 'row' and what does it mean": one row
 * is one open request — the unit that today is one element of
 * `PendingInputBatch.requests` (plus, separately, one pending authorization
 * challenge, one limit prompt, one approval candidate's target). "Row"
 * because the durable ledger is a flat table of them; a batch is not a state
 * shape of its own, it is the set of rows sharing a `groupId` (see
 * ledger.ts for the derivation from the existing batch state).
 */

import type { InputResponse, SessionAuthContext } from "./harness-types.js";

export type RowPhase =
  | { readonly phase: "open" }
  | { readonly phase: "settled"; readonly outcome: unknown }
  | { readonly phase: "dismissed"; readonly reason: string };

export interface Row<Spec = unknown> {
  readonly id: string;
  /** Stable identity across reopen generations (limit prompts). */
  readonly baseId: string;
  readonly generation: number;
  readonly kind: VariantKind;
  /** Variant-owned data, opaque to the interpreter. */
  readonly spec: Spec;
  /** Hook token — where settlement/dismissal payloads deliver. */
  readonly owner: string;
  /** Rows raised by one park share a group; closure fires once per group. */
  readonly groupId: string;
  /** Owning turn, for scoped forced closure. */
  readonly turnId?: string;
  readonly state: RowPhase;
}

export type VariantKind = "approval" | "question" | "limit" | "challenge";

export interface RowRef {
  readonly id: string;
}

/** What the interpreter feeds a reducer. `message` carries no text. */
export type RowInput =
  | {
      readonly kind: "response";
      readonly response: InputResponse;
      readonly responder: SessionAuthContext | null;
      readonly actor: "originating" | "other" | "anonymous";
    }
  | { readonly kind: "message"; readonly actor: "originating" | "other" | "anonymous" }
  | { readonly kind: "callback"; readonly params: Record<string, unknown> }
  | { readonly kind: "deadline" }
  | { readonly kind: "linked"; readonly outcome: string; readonly heldResponse: InputResponse };

/** Complete verdict vocabulary — nothing else exists. */
export type Verdict<Outcome = unknown> =
  | "ignore"
  | { readonly settle: Outcome }
  | {
      readonly reject: "unauthorized" | "invalid" | "policy-failed" | "candidate-cancelled";
    }
  | {
      readonly dismiss: string;
      readonly reopen?: unknown;
      readonly consumeDelivery?: true;
    }
  | { readonly blockOn: unknown };

export interface Variant<Spec = unknown, Outcome = unknown> {
  resolve(row: Row<Spec>, input: RowInput): Verdict<Outcome> | Promise<Verdict<Outcome>>;
  intentKey?(spec: Spec): string | undefined;
  /** Stale-response visibility; "drop" only for limit. */
  readonly staleResponses?: "context-turn" | "drop";
}

export type VariantRegistry = Record<VariantKind, Variant<any, any>>;

export interface HeldCandidate {
  readonly rowId: string;
  readonly linkedRowId: string;
  readonly response: InputResponse;
  /** Admission identity: redeliveries dedupe on {rowId, deliveryId}. */
  readonly deliveryId: string;
}

export interface Group {
  readonly id: string;
  /**
   * The withheld continuation payload. For a session-turn owner this is the
   * batch's `responseMessages` (the withheld assistant output); for a body
   * run it is empty — the run's own frame is the continuation.
   */
  readonly continuation: "pending" | "claimed" | "suppressed";
}

export interface Ledger {
  readonly rows: readonly Row[];
  readonly groups: readonly Group[];
  readonly heldCandidates: readonly HeldCandidate[];
}

/** Ordered effects; the caller persists the ledger before performing them. */
export type LedgerEffect =
  | { readonly kind: "opened"; readonly rowId: string }
  | { readonly kind: "settled"; readonly rowId: string; readonly outcome: unknown }
  | { readonly kind: "dismissed"; readonly rowId: string; readonly reason: string }
  | {
      readonly kind: "reject-response";
      readonly reason: string;
      readonly response: InputResponse | undefined;
      readonly visibility: "context-turn" | "drop";
    }
  | { readonly kind: "claim-continuation"; readonly groupId: string }
  | { readonly kind: "consume-message" }
  /** input.response.pending(reason: authorization-required) on the wire. */
  | { readonly kind: "candidate-pending"; readonly rowId: string; readonly linkedRowId: string };
