---
issue: https://github.com/vercel/eve/issues/483
status: in-review
last_updated: "2026-07-15"
---

# Turn cancellation, layer 3: descendant cascade

## Summary

Cancelling a parent turn now cancels every successfully started child in its
pending runtime-action batch before the parent settles. Local children receive
a resume on their stable `{childSessionId}:cancel` hook. Remote children receive
an authenticated `POST /eve/v1/session/:childSessionId/cancel`. Each child runs
the same cascade, so cancellation follows nested local and remote delegation.

```text
parent cancel
    │
    ├─ wait for dispatch adoption
    │
    ├─ local child  ── resume {sessionId}:cancel
    └─ remote child ── POST /eve/v1/session/:id/cancel
                              │
                              └─ child repeats the cascade
```

## Semantics

- Dispatch remains non-abortable until every start attempt has returned. The
  parent durably records each successful child session id before it observes
  cancellation, closing the start-versus-cancel adoption race.
- Child cancellation requests run in parallel. The parent waits for requests
  to be accepted, not for descendant turns to finish settling.
- A newly started child may return before its cancel hook is registered. Local
  and remote `no_active_turn` responses retry up to 12 attempts at 250 ms.
  Remote network errors and HTTP 408, 425, 429, and 5xx responses use the same
  window, resolving outbound auth again for every attempt.
- Descendant cancellation cannot turn a parent cancellation into a failure.
  Permanent and exhausted request errors are logged; the parent still emits
  `turn.cancelled` followed by `session.waiting` and drops the pending batch.
- Completed, parked, swept, or cancellation-degraded children are benign
  no-ops. This layer cancels active turns only; terminal task cancellation and
  parked-session reset remain separate work.

## Rejected mechanisms

Workflow `Run.cancel()` is not the primary mechanism because it only stops a
workflow at a suspension point and does not abort the in-flight `turnStep`.
Minting a Workflow webhook would duplicate eve's authenticated cancellation
route and expose an unnecessary public capability URL. Reusing the turn hook
and HTTP route keeps local and remote cancellation on the same cooperative
settlement path.
