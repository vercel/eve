---
"eve": patch
---

Hooks can start a session's next turn with `ctx.followUp()` from `turn.settled` and `*` handlers.

Other handlers don't receive it. It follows up a completed turn, or a turn the same hook cancelled, and hooks that follow up one turn share its next turn. It takes `MessageContent` with `session.send()`'s `context` and an optional `auth`, returns `{ queued }` synchronously, and yields to any other turn, cancel, clear, or reset that comes first. `delivery.admitted` records `source: { channel, hook }`.
