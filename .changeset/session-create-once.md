---
"eve": patch
---

Add authenticated create-once session requests through `operationId`. Concurrent or retried creates adopt the active session that first claimed the operation without dispatching duplicate input.
