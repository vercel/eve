---
"eve": minor
---

Session commands now return serializable, followable `Delivery` receipts, with request statuses distinct from session termination and explicit retryability on `SessionNotActiveError`; answers follow the turn work they resume. Session handles use `id`/`stream()` with one line-indexed `SessionStreamOptions`, `SessionInfo` matches `ctx.session`, client handles are type-only exports, local resets become `newSession()`, eval/CLI results use `reply`/`data`, and `invokeTool` returns call-shaped outcomes.
