---
"eve": minor
---

A steering message now aborts the `ctx.abortSignal` of each `execute` workflow tool call the turn waits on, so a waited call stops early and settles with what its body returns, or `{ interrupted: true }` if the body rejects. `ctx.ask(request, { signal })` withdraws the question when the call's `abortSignal` or `signal` aborts, resolving as `cancelled` with an `input.resolved` outcome of `"cancelled"`. `sleep` and `ask_question` now stop early for a new message, and `dismissible` and the `dismissed` status are removed: a question in an `execute` call lapses when the conversation moves on, and a question asked from a `task` stays open.
