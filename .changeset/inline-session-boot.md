---
"eve": patch
---

Start a new session's first model step sooner. Session creation now runs in the same Workflow invocation instead of a separately queued one, the idle timer starts alongside the first turn, and each later turn's cancellation hooks are registered while the session waits for its message.
