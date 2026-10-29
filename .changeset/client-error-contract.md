---
"eve": minor
---

Typed `eve/client` errors now extend the new `EveError` (from `eve/client` and `eve/sessions`) with a stable snake_case `code`, and `session.snapshot()` now returns the full session state, including the opaque `inbox` value.

Match `SessionNotActiveError` on `session_not_active` or `session_not_ready` instead of `EVE_SESSION_NOT_ACTIVE`, expect `ClientError.code` to be `http_error` when the response had none, and narrow with `ClientError.is(error)` and friends instead of `instanceof`. Persist the `session` that `snapshot()` returns as is to keep `inbox` across restores.
