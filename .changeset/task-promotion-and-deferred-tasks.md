---
"eve": patch
---

Promote long-running `bash` commands into durable background tasks via a generic inline-to-task handoff primitive, kill commands that exceed an explicit `timeout` up to 120s, offer `eve__task_wait` and `eve__task_cancel` from step 0 whenever `bash` is present, and defer task instructions into an append-only context message once a session starts its first task.
