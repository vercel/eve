---
"eve": patch
---

`eve/evals` adds `toolCallsOf(events)` and `turn.waitForToolCall(name)`, and event matchers can match a fact's `scope`. `t.target.watchTurn(sessionId, { until })` ends a read that ends no turn, and `session.compact()` returns once its context change settles.
