---
"eve": minor
---

Session commands now return serializable, followable `Delivery` receipts, with request statuses distinct from session termination and explicit retryability on `SessionNotActiveError`; answers follow the turn work they resume. Session handles use `id`/`stream()`, local resets become `newSession()`, eval/CLI results use `reply`/`data`, and `invokeTool` returns call-shaped outcomes.
