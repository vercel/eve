---
"eve": patch
---

Allow cross-channel `receive(...)` calls from routes and schedules to request turn-scoped structured output with Standard JSON Schema or raw JSON Schema. Fresh conversation deliveries also clear schemas retained by earlier failed turns while active runtime and HITL continuations preserve them.
