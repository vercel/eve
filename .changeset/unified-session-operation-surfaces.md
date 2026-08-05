---
"eve": minor
---

Replace continuation-token session APIs with fixed, ID-addressed `client.sessions.create()` and `client.sessions.attach()` handles plus channel-local `from(address)`, `resolveSession(address)`, and `to(channel, target)` operations; delivery now uses positional `send(message, options)`, HITL replies use `respond(inputResponses, options)`, Slack `ctx.receive` and `resolveActiveSession` become `ctx.send` and `resolveSession`, schedules replace `receive(channel, { message, target, auth })` with `to(channel, target).send(message, { auth })`, and event session identity moves to `ctx.session.id` or `session.failed.data.sessionId`.

The eve HTTP API keeps `POST /eve/v1/session` for creation and `POST /eve/v1/session/:sessionId` for follow-ups, moves clear, compact, and reset to `POST /eve/v1/session/:sessionId/{clear,compact,reset}`, rejects continuation tokens in session messages and controls, returns `202` only for accepted work with ID-free no-active results, exposes inactive follow-ups as `409 session_not_active` through `ClientError.code`, and no longer permits canonical `onMessage` hooks to drop deliveries.
