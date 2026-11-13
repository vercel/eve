---
"eve": minor
---

Set `principalPolicy: "keep"` on a channel or a message to let another person's message join a running turn in a shared session, while the turn keeps its caller.

While someone else's message steers a turn, `ctx.session.auth.steeredBy` lists them. eve then holds the caller's identity. Calls the model makes can't use the caller's token, forward the caller, or bind the caller to an event subscription or dynamic schedule. The hold lasts until the caller sends a message or approves a call. Such calls fail with `ConnectionAuthorizationFailedError` and `reason: "turn_steered"`. The new `steered()` policy from `eve/tools/approval` asks the caller before a call made while steered, for tools that authorize from `ctx.session.auth.current` in their own code. The default, `"match"`, keeps today's behavior.
