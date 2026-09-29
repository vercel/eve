---
"eve": patch
---

The default message reducer keeps a task call's tool part running until the task's `task.settled`, and names the task in `part.toolMetadata.eve.taskId`. Previously the call's start receipt marked the part completed while the task was still working, and a receipt that arrived after `task.settled` replaced the task's result, so a failed task could show as completed.
