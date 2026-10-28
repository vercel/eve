---
"eve": minor
---

Typed `eve/client` errors now extend the new `EveError` (from `eve/client` and `eve/sessions`) with a stable snake_case `code`, and the opaque `inbox` client session field is now `resume`.

Match `SessionNotActiveError` on `session_not_active` or `session_not_ready` instead of `EVE_SESSION_NOT_ACTIVE`, expect `ClientError.code` to be `http_error` when the response had none, and narrow with `ClientError.is(error)` and friends instead of `instanceof`. Rename `inbox` to `resume` in `ClientSessionState`, `sessions.attach()` options, and `initialSession` (the HTTP field stays `inbox`); `session.snapshot()` now returns it with the rest of the state.
