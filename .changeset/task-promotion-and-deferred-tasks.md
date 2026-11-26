---
"eve": patch
---

Promote long-running `bash` commands into durable background tasks via a generic inline-to-task handoff primitive, kill commands that exceed an explicit `timeout` up to 120s, and defer `eve__task_wait`, `eve__task_cancel`, and task instructions until a session starts its first task.
