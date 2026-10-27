---
"eve": patch
---

`to(channel, target).send()`, Slack's `onEvent` `ctx.send()`, dynamic schedules' `to().send()`, and channel `receive` hooks now accept the same options as `from(address).send()`, including `history`, `idempotencyKey`, and `title`. Slack derives a threadless target's session from `idempotencyKey`, and a dynamic schedule's keyed send reaches the session its earlier attempt started, so a retried send no longer starts a second thread or session.
