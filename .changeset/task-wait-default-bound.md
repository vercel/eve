---
"eve": patch
---

`eve__task_wait` now waits at most 30 minutes when a call omits `timeoutSeconds`, so a task that never reports can't hold a turn open indefinitely. An explicit `timeoutSeconds` is unchanged.
