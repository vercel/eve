---
"eve": patch
---

Hooks can start a session's next turn with `ctx.send(message, options?)` from a completed `turn.settled`. The message is admitted once the session is idle, records `source: { hook }` on `delivery.admitted`, and yields to any other turn, cancel, or reset that comes first.
