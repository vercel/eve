---
"eve": patch
---

A plain-text answer to a pending `ctx.ask()` or `ask_question` now updates `ctx.session.auth.current` like any follow-up message. Its `message.received` hook, and the rest of the turn, see the request that sent the answer instead of the one that asked.
