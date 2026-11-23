---
"eve": minor
---

Set `principal` on a steering `turnPolicy` to let another person's message join a running turn in a shared session while retaining the turn's caller.

`turnPolicy` takes `{ mode: "queue" }` and `{ mode: "steer", principal }` beside `"queue"` and `"steer"`, where `principal` is `"match"` (the default) or `"retain"`. `PrincipalPolicy` and `TurnMode` are exported from `eve/channels`, and `TurnMode` from `eve/client`. Set `turnPolicy` on a channel, on a server-side send, or in a built-in channel's message hook result (including `eveChannel({ onMessage })`, which also receives the client-requested mode on `ctx.eve.turnPolicy`). An HTTP request body and the client SDK take only `"queue"` or `"steer"`.

`principal: "retain"` keeps the turn's caller (`ctx.session.auth.current` and the turn ID never change). A channel's `deliver` hook receives the delivery's authenticated sender on `payload.auth` while `channel.session.auth.current` stays the turn's caller. While someone else's message steers the turn, `ctx.session.auth.steeredBy` lists them, and eve holds the caller's identity until the caller sends a message or their approval is accepted. The caller's token for a user-scoped connection or provider fails with `ConnectionAuthorizationFailedError` and `reason: "turn_steered"`. So do MCP tool calls with `forwardPrincipal` and connection event subscriptions. Dynamic schedule tools, remote agent calls with `forwardPrincipal`, and tools of `byPrincipal`-scoped memory slots fail with an error carrying the same message, and `byPrincipal`-scoped memory skips automatic capture while steered.

The `steered()` policy from `eve/tools/approval` asks the caller before a call made while steered, enforcing caller-only approval whenever it triggers even if the tool defines a custom `approval.response` policy. Use it for tools or connections that authorize from `ctx.session.auth.current` in their own code. The git extension's `gh` tool (in app-installation mode), the custom skills extension's writes and personal-scope reads, and the deployed self-modification extension's tools ask the same way while steered. The default, `principal: "match"`, keeps current behavior.
