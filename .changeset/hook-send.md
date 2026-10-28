---
"eve": patch
---

Hooks can send the session a message with `ctx.send()` from any handler.

`turnPolicy` decides how it treats the session's turns: `"yield"`, the default and only for hooks, starts the next turn once the running one completes and gives way to anything else that starts a turn first; `"steer"` and `"queue"` are admitted like a person's message with that policy, and never steer a turn that waits on its person. It takes `MessageContent` with `session.send()`'s `context` and an optional `auth`, and returns `{ queued, deliveryId }` synchronously. `delivery.admitted` records `source: { channel, hook }`.
