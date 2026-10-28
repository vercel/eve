---
"eve": patch
---

Hooks can send the session a message with `ctx.send()` from any handler.

It takes `MessageContent` with `session.send()`'s `auth` (required), `context`, and `turnPolicy`, and is admitted like a person's message with that policy, except that it never steers a turn that waits on its person and a person's cancel, clear, or reset drops it. With `turnPolicy: "queue"`, `preemptible: true` makes it wait until nothing else does and drops it if another turn starts first, for loops a person's message should interrupt. It returns `{ sent, deliveryId }` synchronously, and `delivery.admitted` records `source: { channel, hook }`.
