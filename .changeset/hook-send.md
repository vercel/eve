---
"eve": patch
---

Hooks can send the session a message with `ctx.send()` from any handler.

It takes `MessageContent` with `session.send()`'s `auth` (required), `context`, and `turnPolicy`, and is admitted like a person's message with that policy, except that it never steers a turn that waits on its person and a cancel no hook asked for, a clear, or a reset drops it. A hook-only `turnPolicy: "yield"` queues the message until nothing else waits and drops it if another turn starts first, for loops a person's message should interrupt. It returns `{ recorded, deliveryId }` synchronously; every recorded message ends in a `delivery.settled`, `ignored` with a reason if it was dropped, and `delivery.admitted` records `source: { channel, hook }`.
