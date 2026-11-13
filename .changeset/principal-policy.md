---
"eve": minor
---

Set `principalPolicy` on a channel or a message to let another person's message join a running turn in a shared session.

`"retain-caller"` keeps the turn's caller. While someone else's message steers it, `ctx.session.auth.steeredBy` lists them. eve then holds the caller's identity until the caller sends a message or approves a call. The caller's token for a user-scoped connection or provider fails with `ConnectionAuthorizationFailedError` and `reason: "turn_steered"`. So do MCP tool calls with `forwardPrincipal` and connection event subscriptions. Dynamic schedule tools and remote agent calls with `forwardPrincipal` fail with an error that carries the same message.

`"adopt-sender"` also joins the message and makes the sender the turn's caller from the next model call. `steeredBy` is absent, so the identity hold does not apply.

The `steered()` policy from `eve/tools/approval` asks the caller before a call made while steered. Use it for tools that authorize from `ctx.session.auth.current` in their own code. The default, `"match-caller"`, keeps current behavior.
