---
"eve": patch
---

Cancelling a `task()` now also cancels a run that ignores the cancel, and a session that ends mid-turn now stops the workflow tool calls its turn was waiting on.
