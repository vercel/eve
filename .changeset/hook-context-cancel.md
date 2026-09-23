---
"eve": patch
---

Hooks can call `ctx.cancel()` to cancel the running turn. The remaining subscribers for the event still run, then the turn settles like `session.cancel()` with `turn.cancelled` followed by `session.waiting`. This replaces rejecting a turn by throwing from a `turn.started` or `step.started` hook.
