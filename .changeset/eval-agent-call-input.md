---
"eve": patch
---

Record the input the model sent to an agent tool in eval facts, so a subagent or remote agent call in `turn.toolCalls` no longer shows `input: {}` and `t.calledTool(name, { input })` can match it. Thanks @dretanacr for reporting this in #5063.
