---
"eve": patch
---

Clarify that `task_wait` should be called sparingly, only to deliberately withhold a user-facing reply while waiting for a task result. Tasks keep running and their results reach the model without an explicit wait.
