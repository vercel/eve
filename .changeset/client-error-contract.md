---
"eve": minor
---

Errors thrown by `eve/client` now extend the new `EveError` (exported from `eve/client` and `eve/sessions`) with a stable snake_case `code`: match `SessionNotActiveError` on `session_not_active` or `session_not_ready` instead of `EVE_SESSION_NOT_ACTIVE`, expect `ClientError.code` to be `http_error` instead of `undefined` when the response had none, and narrow with `ClientError.is(error)` and friends instead of `instanceof`. The opaque `inbox` field on `ClientSessionState`, `sessions.attach()` options, `initialSession`, and delivery receipts is now `resume`; persist it and pass it back unchanged (the HTTP field stays `inbox`), and `session.snapshot()` now returns it with the rest of the state.
