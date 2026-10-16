---
"eve": patch
---

`eve/evals` adds `toolCallsOf(events)`, `turn.waitForToolCall(name)`, and event matchers for a fact's `scope`. `t.target.watchTurn(sessionId, { until })` can end a read without a turn boundary, and `session.compact()` returns when its context change settles.
