---
"eve": patch
---

A `serve` task's `ctx.reply()` that answers several calls, such as an agent's reply to a message and its correction, now settles them together: `task_wait` no longer reports the task as both done and still working, and the model receives the reply once instead of once per call. Each call still gets its own `task.settled` event.
