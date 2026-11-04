---
"eve": patch
---

`eve__task_wait` without `timeoutSeconds` now waits at most 30 minutes, so a task that never reports no longer holds its parent's turn forever.

The model sees that it stopped waiting and decides whether to cancel the task or wait again. An explicit `timeoutSeconds` is unchanged.
