---
"eve": patch
---

Reaching a session token limit no longer fails interactive sessions outright. The harness now pauses and sends a deterministic HITL continuation prompt; answering "Continue" grants a fresh budget window of the configured size, while "Stop" ends the session gracefully with `session.completed`. Task-mode sessions keep the structured `SESSION_TOKEN_LIMIT_REACHED` failure so parent tool calls receive an error result.
