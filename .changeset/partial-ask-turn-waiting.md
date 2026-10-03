---
"eve": patch
---

Answering some of several pending `ctx.ask()` or subagent questions now parks the open turn again with `turn.waiting`, as a partial answer to tool approvals already does, so clients waiting for the next rest point stop reading instead of hanging until the last answer.
