---
"eve": patch
---

A message that interrupts a waiting tool call, such as a `sleep` or `task_wait`, no longer also interrupts the step that reads it. The stream no longer emits a stray `step.started` with no model call before the step that answers the message.
