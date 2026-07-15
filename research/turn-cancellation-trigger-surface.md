---
issue: https://github.com/vercel/eve/issues/483
status: in-review
last_updated: "2026-07-15"
---

# Turn cancellation, layer 2: HTTP trigger

## Summary

Layer 1 (#573) made each parkable turn claim a stable
`{sessionId}:cancel` hook and settle cancellation as `turn.cancelled` followed
by `session.waiting`. Layer 2 exposes that behavior through
`POST /eve/v1/session/:sessionId/cancel` on `eveChannel()` and adds hosted e2e
coverage.

The route delegates to `Agent.cancelTurn({ sessionId, turnId? })`; hook
addressing and workflow error normalization stay behind `Runtime`. No new
durable state, events, or workflow behavior is introduced.

## HTTP contract

- Auth uses the channel's existing `routeAuth` policy.
- The optional body is `{ "turnId"?: string }`. An empty body targets whichever
  turn owns the hook. A `turnId` limits the request to the observed turn; a
  mismatch is consumed as a no-op.
- Responses include `cache-control: no-store` and `EVE_SESSION_ID_HEADER`.

| Status  | Body                                                | Meaning                                                                                            |
| ------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 202     | `{ ok: true, sessionId, status: "accepted" }`       | A registered cancellation hook accepted the request. Observe the stream for the effective outcome. |
| 202     | `{ ok: true, sessionId, status: "no_active_turn" }` | No resumable cancellation target exists, including unknown and already-settled sessions.           |
| 400     | `{ ok: false, error }`                              | Malformed body or missing session id.                                                              |
| 401/403 | —                                                   | Authentication rejected the request.                                                               |
| 500     | `{ ok: false, error, errorId }`                     | An unexpected runtime failure occurred.                                                            |

Both 202 outcomes are successful so clients can safely retry or issue a late
stop request. Task-mode sessions have no turn cancellation hook and therefore
return `no_active_turn`.

## Semantics

- `"accepted"` is acceptance, not settlement. Confirm an effective cancel by
  observing `turn.cancelled` and `session.waiting`.
- A guarded mismatch returns `"accepted"` because the hook accepted and
  discarded the payload.
- A hook-conflict-degraded current turn is uncancellable. A stale prior owner
  may accept the request, so HTTP status alone cannot identify the affected
  turn.
- Missing hooks, missing owner runs, terminal-run expiry, and terminal-state
  conflicts map to `"no_active_turn"`; other errors become 500s.
- Cancellation leaves partial content on the event stream and retains completed
  side effects; durable model history keeps only content that had already
  settled. It emits no failure event and leaves the session ready for a
  follow-up.

## Data flow

```text
POST /eve/v1/session/:sessionId/cancel { turnId? }
  │
  ├─ routeAuth
  ├─ parse body
  └─ agent.cancelTurn
       │
       └─ runtime.cancelTurn
            └─ resumeHook(`${sessionId}:cancel`, { turnId? })
                 ├─ missing / terminal target → no_active_turn
                 └─ accepted payload → accepted
```

The token helper lives in `execution/turn-cancellation-token.ts`; the HTTP
route does not import workflow hook APIs.

## Coverage

- Unit tests cover parsing, auth, Agent delegation, result mapping, headers,
  terminal races, and unexpected errors.
- World-local integration cancels a hanging tool through the real route,
  verifies stale guards are no-ops, treats unknown and late requests as
  `no_active_turn`, and proves the next turn succeeds.
- The `agent-cancellation` e2e fixture waits for `actions.requested`, cancels
  over HTTP, checks `turn.cancelled` → `session.waiting`, then sends a follow-up.
  Its stream open retries the same short propagation window as the client.

## Out of scope

Task-mode terminal cancellation, caller-supplied reasons, descendant cascade,
session reset, and client/channel convenience APIs remain separate work.

## Delivery

Ship the route, Runtime/Agent operation, docs, tests, e2e fixture, and patch
changeset together.
