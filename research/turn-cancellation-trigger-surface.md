---
issue: https://github.com/vercel/eve/issues/483
status: proposed
last_updated: "2026-07-15"
---

# Turn cancellation, layer 2: trigger surface

## Summary

Layer 1 (#573) made turns cancellable in-process: each turn workflow run
claims the stable session-scoped cancel hook (`{sessionId}:cancel`), and
resuming it settles the turn as `turn.cancelled` → `session.waiting` —
never as a failure. The only trigger so far is tests resuming the hook
directly. Layer 2 exposes the first production trigger: a
`POST /eve/v1/session/:sessionId/cancel` route on `eveChannel()` whose
handler is pure derivation — resume `{sessionId}:cancel` with the
caller's optional `turnId` guard and map "no live hook" to a benign
"nothing to cancel" success. No new durable state, hooks, events, or
workflow changes; every semantic this route exposes shipped in layer 1.

This layer also unshelves the end-to-end coverage parked since layer 0:
an `agent-cancellation` e2e fixture exercising the full HTTP trigger
path in CI.

## Scope decisions (settled at review)

- **Task-mode terminal semantics: deferred.** Layer 1 registers the
  cancel hook only for parkable sessions; unparkable root task runs get
  no hook, so cancelling one returns `no_active_turn`. Terminal
  cancellation for task mode gets its own follow-up design.
- **Caller-supplied reason: omitted.** The hook payload stays
  `{ turnId? }` and the canonical `TurnCancelledError` remains the only
  cancellation reason. An optional `reason` field is purely additive
  later.
- **Duplicate/late cancels need no single-flighting.** Upstream fixes
  workflow#2848 and workflow#2808 made a duplicate resume safe; the
  route treats "already resumed/disposed" as success.

## Authoring API

One route, added to `eveChannel()` beside the existing session routes.
No new definition surfaces; agents using `eveChannel()` get the route
with no config change.

### `POST /eve/v1/session/:sessionId/cancel`

- **Auth**: `routeAuth(req, input.auth)`, identical to the
  create/continue/stream routes.
- **Body** (optional): `{ "turnId"?: string }`. An absent or empty body
  cancels whatever turn is currently running — the right default for a
  plain stop button. A `turnId` scopes the cancel to the turn the caller
  observed (every stream event is stamped with its `turnId`); a
  mismatched guard is consumed inside the turn as a benign no-op.
- **Responses**:

  | Status  | Body                                                | Meaning                                                                                                                        |
  | ------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
  | 202     | `{ ok: true, sessionId, status: "cancelling" }`     | Cancel delivered to a live turn. Settlement is observed on the session stream.                                                 |
  | 202     | `{ ok: true, sessionId, status: "no_active_turn" }` | Nothing to cancel: no turn in flight, turn already settled, duplicate cancel, or an uncancellable (task-mode / degraded) turn. |
  | 400     | `{ ok: false, error }`                              | Malformed body / missing session id.                                                                                           |
  | 404     | `{ ok: false, error }`                              | Unknown session (same `getSession` check as the continue route).                                                               |
  | 401/403 | —                                                   | From `routeAuth`, as on every eve route.                                                                                       |

  Responses carry `cache-control: no-store` and the
  `EVE_SESSION_ID_HEADER`, matching the sibling routes.

## Semantics

- **Cancellation is asynchronous.** `"cancelling"` means the payload was
  delivered to the live cancel hook — not that the turn is already
  settled. Callers observe completion on the session stream:
  `turn.cancelled` followed by `session.waiting` (stream version 19,
  unchanged). A delivered cancel whose `turnId` guard names a different
  turn is consumed as a no-op inside the turn; the route cannot (and
  does not try to) distinguish this from an effective cancel.
- **Both 202 outcomes are success.** Clients can fire-and-forget a stop
  button with no error handling; the `status` field exists so richer
  clients (layer 4's `MessageResponse.cancel()`, eval controls) can
  surface the distinction.
- **`no_active_turn` derivation**: `resumeHook` rejecting with
  `HookNotFoundError` (detected via the established
  `HookNotFoundError.is(error)` pattern, `execution/workflow-runtime.ts:174`).
  Any other rejection is a 500 — it indicates a runtime fault, not a
  benign race.
- **Everything downstream is layer 1, unchanged**: partial content is
  kept, cancel is never a failure, the session accepts the next message
  normally, descendants are not cascaded to (layer 3).

## Data flow

```text
client                POST /eve/v1/session/:sessionId/cancel  { turnId? }
  │
eveChannel route      public/channels/eve.ts
  routeAuth → getSession (404) → parse body (400)
  resumeHook(sessionCancelHookToken(sessionId), { turnId? })
  │        └─ HookNotFoundError → 202 no_active_turn
  ▼
cancel hook           execution/turn-cancellation-control.ts (layer 1)
  guard match → durable abort → turn settles cancelled (layer 1 epilogue)
```

The handler uses `resumeHook` from `#internal/workflow/runtime.js` and
`sessionCancelHookToken` from `#execution/turn-cancellation-control.js` —
the exact call shape layer 1's integration tests already exercise
(`execution/turn-cancellation.integration.test.ts:205`).

## Testing

- **Unit** (`public/channels/eve.test.ts` additions): body parsing
  (absent, empty, `turnId`, malformed), auth rejection, unknown session
  404, `HookNotFoundError` → `no_active_turn`, other errors → 500,
  response headers/shape.
- **Integration**: route handler wired over world-local against a real
  `turnWorkflow` run — cancel mid-tool via the route settles
  `turn.cancelled` → `session.waiting` with zero failure events;
  duplicate POST returns `no_active_turn`; stale `turnId` guard returns
  `"cancelling"` and the turn keeps running. Mirrors
  `turn-cancellation.integration.test.ts` with the HTTP route replacing
  the direct `resumeHook` call.
- **E2E** (`e2e/fixtures/agent-cancellation/`, new): fixture agent with
  a hanging `wait-for-cancellation` tool that resolves only when its
  `ctx.abortSignal` aborts. Eval: send a message, await the tool's
  `step.started` on the stream, POST cancel, assert
  `turn.cancelled` → `session.waiting`, then run a follow-up turn
  normally. Deterministic and self-contained; needs only model-provider
  credentials. This is the first automated exercise of cancellation
  against the hosted Vercel world — relevant because the workflow#2808
  disposal-race fix is confirmed only on world-local. Layer 1's deferred
  control-hook disposal mitigation stays in place regardless.

## Out of scope

- Task-mode terminal cancellation (follow-up design; cancel on an
  unparkable run is `no_active_turn` here).
- Caller-supplied cancellation reasons.
- Descendant cascade — subagent inbox propagation, remote cancel POST
  (layer 3). A cancelled parent still merely drops late child results.
- Client/channel/eval surfaces — `MessageResponse.cancel()`, channel
  ops, `/new` (layer 4, governed with
  `research/channel-session-reset.md`).
- Cancelling parked sessions or session-scoped cancellation.
- The legacy non-turn-inbox workflow path.

## Delivery

One PR with a **patch** changeset: route constant in
`protocol/routes.ts`, handler in `eveChannel()`, unit + integration
tests, the `agent-cancellation` e2e fixture and eval, and the HTTP API
docs page updated with the new route.
