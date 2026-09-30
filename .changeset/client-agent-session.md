---
"eve": minor
---

`session.streamSubagent(started)` is now `session.agent(started).stream()`. `session.agent()` takes an `agent.started` event and returns a `ClientAgentSession` handle with the child's `name`, `sessionId`, and `taskId`; eval sessions get the same `session.agent(started).stream()`.
