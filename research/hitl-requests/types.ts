/**
 * Prototype types. A Request is one durable question awaiting an outcome: the
 * unit represented today by one `PendingInputBatch.requests` element, one
 * session-limit prompt, or one pending connection authorization. Requests
 * created by one parked operation share a Group.
 */

import type { InputResponse, SessionAuthContext } from "./harness-types.js";

export type RequestState =
  | { readonly phase: "open" }
  | { readonly phase: "settled"; readonly outcome: unknown }
  | { readonly phase: "dismissed"; readonly reason: string };

export interface Request<Spec = unknown> {
  readonly id: string;
  /** Stable identity across reopen generations (limit prompts). */
  readonly baseId: string;
  readonly generation: number;
  readonly kind: RequestKind;
  /** RequestReducer-owned data, opaque to the interpreter. */
  readonly spec: Spec;
  /** Requests created by one parked operation share a group; closure fires once per group. */
  readonly groupId: string;
  /** Owning turn, for scoped forced closure. */
  readonly turnId?: string;
  readonly state: RequestState;
}

export type RequestKind = "approval" | "question" | "limit" | "authorization";

export interface RequestRef {
  readonly id: string;
}

/** What the interpreter feeds a reducer. `message` carries no text. */
export type RequestInput =
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

/** Every verdict a reducer can return — the closed set. */
export type Verdict<Outcome = unknown> =
  | "ignore"
  | { readonly settle: Outcome }
  | {
      readonly reject: "unauthorized" | "invalid" | "policy-failed" | "attempt-cancelled";
    }
  | {
      readonly dismiss: string;
      readonly reopen?: unknown;
      readonly consumeDelivery?: true;
    }
  | { readonly blockOn: unknown };

export interface RequestReducer<Spec = unknown, Outcome = unknown> {
  resolve(request: Request<Spec>, input: RequestInput): Verdict<Outcome> | Promise<Verdict<Outcome>>;
  intentKey?(spec: Spec): string | undefined;
  /** Stale-response visibility; "drop" only for limit. */
  readonly staleResponses?: "context-turn" | "drop";
}

export type RequestReducerRegistry = Record<RequestKind, RequestReducer<any, any>>;

export interface ResponseAttempt {
  readonly requestId: string;
  readonly authorizationRequestId: string;
  readonly response: InputResponse;
  /** Admission identity: redeliveries dedupe on {requestId, deliveryId}. */
  readonly deliveryId: string;
}

export interface Group {
  readonly id: string;
  /** The parked operation to notify once every request is terminal. */
  readonly owner: string;
  /**
   * `ready` remains retryable until idempotent owner delivery acknowledges it.
   * Forced closure moves a group to `cancelled` without delivering completion.
   */
  readonly completion: "waiting" | "ready" | "delivered" | "cancelled";
}

export interface Ledger {
  readonly requests: readonly Request[];
  readonly groups: readonly Group[];
  readonly responseAttempts: readonly ResponseAttempt[];
}

/** Ordered effects; the caller persists the ledger before performing them. */
export type LedgerEffect =
  | { readonly kind: "opened"; readonly requestId: string }
  | { readonly kind: "settled"; readonly requestId: string; readonly outcome: unknown }
  | { readonly kind: "dismissed"; readonly requestId: string; readonly reason: string }
  | {
      readonly kind: "reject-response";
      readonly reason: string;
      readonly response: InputResponse | undefined;
      readonly visibility: "context-turn" | "drop";
    }
  | { readonly kind: "deliver-group"; readonly groupId: string; readonly owner: string }
  | { readonly kind: "consume-message" }
  /** input.response.pending(reason: authorization-required) on the wire. */
  | { readonly kind: "attempt-pending"; readonly requestId: string; readonly authorizationRequestId: string };
