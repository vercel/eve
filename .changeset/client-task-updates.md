---
"eve": patch
---

Expose durable background task state to clients. Parent session streams now emit `task.updated`, the default frontend reducer projects `data.tasks`, and fixed session handles can cancel an owned task by `taskId`.
