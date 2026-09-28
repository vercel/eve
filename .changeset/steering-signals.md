---
"eve": minor
---

Workflow tool bodies get `ctx.interruptSignal`, which aborts once when a steering message arrives while the turn waits on the call, and `ctx.ask(request, { signal })` withdraws the question when the signal aborts, resolving as `cancelled` with an `input.resolved` outcome of `"cancelled"`. `sleep` and `ask_question` now stop early for a new message, and `dismissible` and the `dismissed` status are removed; pass `{ signal: ctx.interruptSignal }` to `ctx.ask` instead.
