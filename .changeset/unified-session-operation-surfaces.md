---
"eve": minor
---

Replace continuation-token session APIs with fixed, ID-addressed handles and consistent channel-local operations. This is a breaking migration across the following public surfaces:

- TypeScript clients now use `client.sessions.create(input)` to start a session and `client.sessions.attach(sessionId)` to obtain a fixed handle; `client.session(...)` and continuation-token client state are removed.
- Client, eval, frontend, fixed-session, and Slack message delivery now use positional `send(message, options)`. HITL replies use the separate `respond(inputResponses, options)` method, and `message` and `inputResponses` are mutually exclusive.
- Custom channels use `from(address)` for channel-local operations, top-level `resolveSession(address)` to resolve the current owner, `attachSession(sessionId)` for an immutable session handle, and `to(channel, target)` for cross-channel delivery.
- Slack message and interaction hooks expose `ctx.send`, `ctx.respond`, `ctx.cancel`, `ctx.compact`, `ctx.clear`, `ctx.reset`, and `ctx.resolveSession`. For generic events, the target is passed in each operation's options; `ctx.receive` and `resolveActiveSession` are removed.
- Schedule handlers replace `receive(channel, { message, target, auth })` with `to(channel, target).send(message, { auth })`.
- Channel event session identity moves to `ctx.session.id`, while `session.failed` includes `sessionId` in its event data.
- The eve HTTP API keeps `POST /eve/v1/session` for creation and `POST /eve/v1/session/:sessionId` for follow-ups. Clear, compact, and reset move from continuation-token body routes to `POST /eve/v1/session/:sessionId/{clear,compact,reset}`; cancel and streaming remain ID-addressed.
- Session message and control bodies no longer accept or return continuation tokens. Accepted asynchronous work returns HTTP `202`; no-active operation results omit `sessionId`, and inactive follow-ups return HTTP `409` with `code: "session_not_active"`, available as `ClientError.code`.
- Canonical eve `onMessage` hooks can no longer drop an otherwise authorized delivery by returning `null`.
