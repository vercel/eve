---
"eve": patch
---

Hooks can call `ctx.cancel()` to cancel the running turn after the remaining subscribers for the event run. The turn then settles like `session.cancel()`, with `turn.cancelled` followed by `session.waiting`.
