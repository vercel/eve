---
"eve": minor
---

Hooks take `select` with `run`, or `events` handlers. `run` acts once for each new selection. Both return `cancel(reason?)` or `compact({ reason? })` from `eve/hooks`, which act once per occurrence, and `ctx.occurrence.id` keys a side effect that must happen once. `ctx.cancel()` is gone.
