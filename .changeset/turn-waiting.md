---
"eve": minor
---

A question or sign-in from inside a running call, such as a workflow tool's `ctx.ask()`, `ask_question`, or a subagent's question or connection sign-in, no longer ends the turn: the stream emits `input.requested` or `authorization.required`, then the new `turn.waiting` event, and the turn resumes under the same `turnId`. The session you answer on now emits `input.resolved` for every subagent or workflow tool question it routes an answer to, and `send().result()` stops at `turn.waiting` only while a question is pending. The message stream version is now 26, which older eve clients reject, so upgrade them with the server.
