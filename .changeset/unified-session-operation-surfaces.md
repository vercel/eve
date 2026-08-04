---
"eve": minor
---

Standardize session operations around ID-addressed HTTP and fixed-session handles plus channel-local `from(address)`, top-level `resolveSession(address)`, and cross-channel `to(channel, target)` methods. This breaking migration makes client, eval, frontend, fixed-session, and Slack `send` calls take the message positionally, adds separate `respond(inputResponses, options)` methods, replaces schedule `send(channel, input)` with `to(...).send(...)`, and moves channel event session identity to `ctx.session.id` or `session.failed` event data.

Canonical eve HTTP messages now always dispatch, session continuation tokens exposed to channel authors are channel-local, and cancellation consistently returns an accepted result with `sessionId` or an ID-free `no_active_turn` result. Accepted cancellation requests return HTTP 202, and `ClientError.code` exposes stable server error codes such as `session_not_active`.
