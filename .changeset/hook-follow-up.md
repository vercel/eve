---
"eve": patch
---

Hooks can start a session's next turn with `ctx.followUp(message, options?)` from `turn.settled` (and `*`) handlers; other handlers don't receive it. It takes `MessageContent` with `session.send()`'s `context` and `idempotencyKey`, returns `{ queued }` synchronously, and yields to any other turn, cancel, or reset that comes first. `delivery.admitted` records `source: { channel, hook }`.
