---
"eve": patch
---

`to(channel, target).send()`, Slack's `onEvent` `ctx.send()`, and channel `receive` hooks now accept the same options as `from(address).send()`, including `history`, `idempotencyKey`, and `title`. Slack derives a threadless target's session from `idempotencyKey`, so a retried send reaches the same session instead of starting a second thread.
