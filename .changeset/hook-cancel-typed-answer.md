---
"eve": patch
---

`ctx.cancel()` in a `message.received` hook now cancels the turn when the message is a plain-text answer to a pending `ask_question` or `ctx.ask()` question. The question resolves as `cancelled` and the tool call never receives the text. Before, eve logged a warning and delivered the answer. `ctx.cancel()` in an `action.partial` hook for a workflow tool's report now cancels the turn waiting on that tool too.
