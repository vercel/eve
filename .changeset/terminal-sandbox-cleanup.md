---
"eve": patch
---

Invoke sandbox provider cleanup when a durable session completes, expires, or fails. Custom providers can implement `onSessionEnd()` to release session-owned resources directly from persisted state.
