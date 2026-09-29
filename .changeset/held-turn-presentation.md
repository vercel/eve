---
"eve": minor
---

When eve holds a turn because its tasks are still working, the stream now emits `turn.waiting` for that turn in every session, and `session.waiting` comes only after the turn really ends. In a root session, the model's text before the wait now completes as an ordinary `"stop"` message, so a person sees it right away. Child and schedule turns still report it as `"tool-calls"`, so they post once. `send().result()` and MCP `agent_get` return the final reply, not the text written before the wait.
