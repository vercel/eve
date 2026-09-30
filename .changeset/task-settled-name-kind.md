---
"eve": patch
---

`task.settled` events now carry the task's tool `name` and `kind`, the same values as on the call's `task.started`, so clients and hooks can label a settled task without tracking its start. Events recorded by earlier versions omit both fields.
