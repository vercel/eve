---
"eve": patch
---

Custom channel routes can now cancel a session's in-flight turn: route handlers receive a `cancel({ continuationToken, turnId? })` helper addressed by the channel-local continuation token, and `Session` handles returned by `send()` and `getSession()` expose `cancel({ turnId? })` for session-id-addressed cancellation. `ClientSession.cancel()` accepts the same optional `turnId` stale-request guard.
