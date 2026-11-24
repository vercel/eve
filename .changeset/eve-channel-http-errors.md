---
"eve": minor
---

Throw `HttpError` or `TooManyRequestsError` from `eve/channels/auth` in an auth function or in `eveChannel({ onMessage })` to answer with that status, such as a `429` for a caller over a rate limit; a refused message creates no session and sends no message.

`UnauthenticatedError` and `ForbiddenError` now extend `HttpError`. `routeAuth` now honors only `HttpError` instances, from any copy of eve, instead of any thrown object with a `response` property, so an unrelated error that carries an upstream `Response` no longer reaches the client. Throw an `HttpError` instead of a custom error with `response`.
