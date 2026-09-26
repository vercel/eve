---
"eve": minor
---

When a root session's turn waits on its tasks, the model's interim text now completes as an ordinary `"stop"` message and the stream emits `session.waiting` with the held `turnId`, which `isCurrentTurnBoundaryEvent` doesn't treat as a boundary. `turn.completed`, `send().result()`, eval `t.send()`, and MCP `agent_get` resolve only at the turn's real end, while child and schedule turns keep reporting the held step as `"tool-calls"` so they post once.

The message stream version is now 26, so a client that only accepts up to v25 fails the stream with an unsupported-version error instead of settling a held turn early. eve clients accept v21 through v26.
