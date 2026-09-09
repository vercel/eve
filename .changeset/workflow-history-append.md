---
"eve": patch
---

Add `ctx.appendHistory()` for workflow tools to add validated application-owned messages to their owning session. Appends are durable and idempotent: an identical retry acknowledges the existing mutation, while a conflicting retry fails.
