/**
 * Prototype: HITL request interpreter.
 *
 * Companion to ../hitl-requests.md. Not wired into the build; typed
 * against the real harness shapes (`PendingInputBatch`, `InputRequest`,
 * `InputResponse`, `ResolvePendingInputResult`) so every claim in the doc is
 * checkable against the code it must replace. See ledger.ts for how interpreter
 * state derives from the EXISTING batch state without a new store, and
 * call-site.ts for where this runs in the step loop (unchanged: between steps).
 */

import type { InputResponse } from "./harness-types.js";
import type {
  Ledger,
  LedgerEffect,
  Request,
  RequestInput,
  RequestRef,
  Verdict,
  RequestReducerRegistry,
} from "./types.js";

/**
 * One interpreter pass: interpret one delivery against the ledger.
 *
 * Owns everything kind-agnostic, in order:
 *   1. staleness — responses naming terminal requests reject before any reducer
 *   2. attempt identity — single winner per request per pass
 *   3. reducer dispatch — one reducer, one request, one verdict
 *   4. verdict application — settle / reject / dismiss / blockOn bookkeeping
 *   5. group completion — mark terminal groups ready for retryable owner delivery
 *
 * The caller persists `ledger` before performing `effects` (state before
 * effects). Reducers may be async (authored policies); the interpreter awaits
 * them sequentially in request order so replay is journal-deterministic.
 */
export async function interpretDelivery(input: {
  readonly ledger: Ledger;
  /**
   * Server-assigned admission id for this delivery. Response attempt identity is
   * {requestId, deliveryId}: a workflow-level redelivery reuses it (held
   * attempts dedupe on it); a new delivery is a new attempt.
   */
  readonly deliveryId: string;
  readonly responses: readonly InputResponse[];
  readonly message: { readonly actor: "originating" | "other" | "anonymous" } | undefined;
  /** Connection-authorization callbacks and fired deadlines, arrival-ordered. */
  readonly callbacks?: readonly { readonly requestId: string; readonly params: Record<string, unknown> }[];
  readonly deadlines?: readonly { readonly requestId: string }[];
  readonly reducers: RequestReducerRegistry;
}): Promise<{ ledger: Ledger; effects: LedgerEffect[] }> {
  let ledger = input.ledger;
  const effects: LedgerEffect[] = [];

  // 1+2. Responses: staleness, then per-request dispatch. One response per
  // request id per delivery (canonicalized upstream, as today).
  for (const response of input.responses) {
    const request = ledger.requests.find((attempt) => attempt.id === response.requestId);

    if (request === undefined) {
      // Unknown id: malformed, never created. #1224 reason "invalid".
      effects.push({ kind: "reject-response", reason: "invalid", response, visibility: "context-turn" });
      continue;
    }
    if (request.state.phase !== "open") {
      // Retained terminal request: single-winner already decided. Visibility is the
      // request kind's one setting (staleResponses).
      const visibility = input.reducers[request.kind].staleResponses ?? "context-turn";
      effects.push({ kind: "reject-response", reason: "stale", response, visibility });
      continue;
    }
    // Redelivery of a delivery whose attempt is already held on a
    // authorization: return the existing pending attempt, never a second
    // authorization (owner.approval.response.pend-authorization dedupe).
    const held = ledger.responseAttempts.find(
      (attempt) => attempt.requestId === request.id && attempt.deliveryId === input.deliveryId,
    );
    if (held !== undefined) continue;

    const verdict = await input.reducers[request.kind].resolve(request, {
      kind: "response",
      response,
      responder: response.responder ?? null,
      actor: response.actor ?? "anonymous",
    });
    ({ ledger } = applyVerdict({ ledger, request, verdict, effects, response, deliveryId: input.deliveryId }));
  }

  // Callbacks and deadlines dispatch to their authorization requests, then any request
  // that was blocked on a newly terminal linked request is re-fed in the SAME
  // pass (pend-authorization: authorized → re-run the authorizer without
  // a further external delivery).
  for (const callback of input.callbacks ?? []) {
    ledger = await dispatchToRequest(ledger, callback.requestId, { kind: "callback", params: callback.params }, input.reducers, effects);
  }
  for (const deadline of input.deadlines ?? []) {
    ledger = await dispatchToRequest(ledger, deadline.requestId, { kind: "deadline" }, input.reducers, effects);
  }
  ledger = await refeedUnblockedAttempts(ledger, input.reducers, effects);

  // 3. Message observation: broadcast to every open request. Reducers answer
  // independently; mixed batches (owner.batch.message.dismiss-question-only)
  // fall out of per-request dispatch with no batch-level case.
  if (input.message !== undefined) {
    let consumed = false;
    for (const request of [...ledger.requests]) {
      if (request.state.phase !== "open") continue;
      const verdict = await input.reducers[request.kind].resolve(request, {
        kind: "message",
        actor: input.message.actor,
      });
      if (verdict === "ignore") continue;
      // At most one consumer per delivery, deterministic by request order.
      if (typeof verdict === "object" && "dismiss" in verdict && verdict.consumeDelivery === true) {
        if (consumed) continue;
        consumed = true;
      }
      ({ ledger } = applyVerdict({ ledger, request, verdict, effects }));
    }
    if (consumed) effects.push({ kind: "consume-message" });
  }

  // 4. Group completion: terminal groups become ready. A ready group keeps
  // emitting retryable delivery work until the owner acknowledges it.
  ledger = prepareCompletedGroups(ledger, effects);

  return { ledger, effects };
}

/** Dispatches one input to one open request and applies the verdict. */
async function dispatchToRequest(
  ledger: Ledger,
  requestId: string,
  rowInput: { readonly kind: "callback"; readonly params: Record<string, unknown> } | { readonly kind: "deadline" },
  reducers: RequestReducerRegistry,
  effects: LedgerEffect[],
): Promise<Ledger> {
  const request = ledger.requests.find((attempt) => attempt.id === requestId);
  // A callback after completion, or with no matching authorization, is rejected
  // stale — never silently queued (owner.auth.callback.reject-stale).
  if (request === undefined || request.state.phase !== "open") {
    effects.push({ kind: "reject-response", reason: "stale", response: undefined, visibility: "context-turn" });
    return ledger;
  }
  const verdict = await reducers[request.kind].resolve(request, rowInput);
  return applyVerdict({ ledger, request, verdict, effects }).ledger;
}

/**
 * Re-feeds every request whose held attempt's linked request reached terminal
 * state in this pass, with the linked outcome as data. The blocking reducer
 * re-runs the response policy (pend-authorization: authorized re-runs the authorizer;
 * declined → unauthorized; failed/timed-out → policy-failed).
 */
async function refeedUnblockedAttempts(
  input: Ledger,
  reducers: RequestReducerRegistry,
  effects: LedgerEffect[],
): Promise<Ledger> {
  let ledger = input;
  for (const held of [...ledger.responseAttempts]) {
    const linked = ledger.requests.find((request) => request.id === held.authorizationRequestId);
    if (linked === undefined || linked.state.phase === "open") continue;
    const request = ledger.requests.find((attempt) => attempt.id === held.requestId);
    ledger = { ...ledger, responseAttempts: ledger.responseAttempts.filter((c) => c !== held) };
    if (request === undefined || request.state.phase !== "open") continue;
    const outcome =
      linked.state.phase === "settled" ? String(linked.state.outcome) : "failed";
    const verdict = await reducers[request.kind].resolve(request, {
      kind: "linked",
      outcome,
      heldResponse: held.response,
    });
    ({ ledger } = applyVerdict({ ledger, request, verdict, effects, response: held.response, deliveryId: held.deliveryId }));
  }
  return ledger;
}

/** Applies one verdict to one request. The only writer of request phases. */
function applyVerdict(input: {
  readonly ledger: Ledger;
  readonly request: Request;
  readonly verdict: Verdict;
  readonly effects: LedgerEffect[];
  readonly response?: InputResponse;
  readonly deliveryId?: string;
}): { ledger: Ledger } {
  const { request, verdict, effects } = input;
  let ledger = input.ledger;

  if (verdict === "ignore") return { ledger };

  if ("settle" in verdict) {
    ledger = setRequestState(ledger, request.id, { phase: "settled", outcome: verdict.settle });
    effects.push({ kind: "settled", requestId: request.id, outcome: verdict.settle });
    // A request settling while it holds a blocked attempt cancels the linked
    // request and rejects the held attempt (settle-cancel-pending-attempt).
    const held = ledger.responseAttempts.find((attempt) => attempt.requestId === request.id);
    if (held !== undefined) {
      ledger = setRequestState(ledger, held.authorizationRequestId, { phase: "settled", outcome: "cancelled" });
      ledger = { ...ledger, responseAttempts: ledger.responseAttempts.filter((c) => c !== held) };
      effects.push({ kind: "reject-response", reason: "attempt-cancelled", response: held.response, visibility: "context-turn" });
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
    return { ledger }; // request stays open — rejection never settles
  }

  if ("dismiss" in verdict) {
    ledger = setRequestState(ledger, request.id, { phase: "dismissed", reason: verdict.dismiss });
    effects.push({ kind: "dismissed", requestId: request.id, reason: verdict.dismiss });
    if (verdict.reopen !== undefined) {
      const reopened: Request = {
        ...request,
        id: `${request.baseId}:${request.generation + 1}`,
        generation: request.generation + 1,
        spec: verdict.reopen,
        state: { phase: "open" },
      };
      ledger = { ...ledger, requests: [...ledger.requests, reopened] };
      effects.push({ kind: "opened", requestId: reopened.id });
    }
    return { ledger };
  }

  // blockOn: open the linked authorization request, hold the attempt. The request is
  // re-fed a "linked" input when the linked request reaches terminal — same
  // pass via refeedUnblockedAttempts, or a later one.
  const linked: Request = {
    id: `${request.id}:authorization`,
    baseId: `${request.id}:authorization`,
    generation: 0,
    kind: "authorization",
    spec: verdict.blockOn,
    groupId: request.groupId,
    state: { phase: "open" },
  };
  effects.push({ kind: "attempt-pending", requestId: request.id, authorizationRequestId: linked.id });
  return {
    ledger: {
      ...ledger,
      requests: [...ledger.requests, linked],
      responseAttempts: [
        ...ledger.responseAttempts,
        {
          requestId: request.id,
          authorizationRequestId: linked.id,
          response: input.response!,
          deliveryId: input.deliveryId ?? "",
        },
      ],
    },
  };
}

/**
 * Forced closure: turn cancel or session end. Dismisses every open Request in the scope, cancels Group completion, and
 * removes waiting ResponseAttempts. Uniform —
 * no reducer consulted; authorization dismissals translate to
 * `completed(cancelled)` at the event layer.
 */
export function closeForced(input: {
  readonly ledger: Ledger;
  readonly scope: { readonly turnId: string } | "session";
}): { ledger: Ledger; effects: LedgerEffect[] } {
  const effects: LedgerEffect[] = [];
  let ledger = input.ledger;
  for (const request of ledger.requests) {
    if (request.state.phase !== "open") continue;
    if (input.scope !== "session" && request.turnId !== input.scope.turnId) continue;
    const reason = input.scope === "session" ? "session-ended" : "cancelled";
    ledger = setRequestState(ledger, request.id, { phase: "dismissed", reason });
    effects.push({ kind: "dismissed", requestId: request.id, reason });
  }
  // Groups touched by forced closure are cancelled instead of delivered.
  ledger = {
    ...ledger,
    groups: ledger.groups.map((group) =>
      group.completion === "waiting" && groupIsTerminal(ledger, group.id)
        ? { ...group, completion: "cancelled" }
        : group,
    ),
    responseAttempts: [],
  };
  return { ledger, effects };
}

/**
 * Intent dedup at creation (invariant 4): a new request whose kind-specific intent
 * key matches an open request resolves already-pending instead of opening.
 * Cross-owner by design — a body run and a session turn share the check.
 */
export function createRequests(input: {
  readonly ledger: Ledger;
  readonly requests: readonly Request[];
  readonly reducers: RequestReducerRegistry;
}): { ledger: Ledger; alreadyPending: readonly { request: Request; openRef: RequestRef }[] } {
  const alreadyPending: { request: Request; openRef: RequestRef }[] = [];
  const admitted: Request[] = [];
  for (const request of input.requests) {
    const key = input.reducers[request.kind].intentKey?.(request.spec);
    const open =
      key === undefined
        ? undefined
        : input.ledger.requests.find(
            (attempt) =>
              attempt.state.phase === "open" &&
              attempt.kind === request.kind &&
              input.reducers[attempt.kind].intentKey?.(attempt.spec) === key,
          );
    if (open !== undefined) {
      alreadyPending.push({ request, openRef: { id: open.id } });
      continue;
    }
    admitted.push(request);
  }
  return {
    ledger: { ...input.ledger, requests: [...input.ledger.requests, ...admitted] },
    alreadyPending,
  };
}

function prepareCompletedGroups(ledger: Ledger, effects: LedgerEffect[]): Ledger {
  const groups = ledger.groups.map((group) =>
    group.completion === "waiting" && groupIsTerminal(ledger, group.id)
      ? { ...group, completion: "ready" as const }
      : group,
  );
  for (const group of groups) {
    if (group.completion === "ready") {
      effects.push({ kind: "deliver-group", groupId: group.id, owner: group.owner });
    }
  }
  return { ...ledger, groups };
}

/** Called only after idempotent owner delivery succeeds. */
export function acknowledgeGroupDelivery(ledger: Ledger, groupId: string): Ledger {
  return {
    ...ledger,
    groups: ledger.groups.map((group) =>
      group.id === groupId && group.completion === "ready"
        ? { ...group, completion: "delivered" }
        : group,
    ),
  };
}

function groupIsTerminal(ledger: Ledger, groupId: string): boolean {
  return ledger.requests
    .filter((request) => request.groupId === groupId)
    .every((request) => request.state.phase !== "open");
}

function setRequestState(ledger: Ledger, requestId: string, state: Request["state"]): Ledger {
  return {
    ...ledger,
    requests: ledger.requests.map((request) => (request.id === requestId ? { ...request, state } : request)),
  };
}
