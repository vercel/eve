---
"eve": patch
---

`task.settled` for a cancelled call now carries `cancel.reason`: `"task_cancel"` when the model called `task_cancel`, `"session_cancel"` when someone cancelled the session, or `"turn_ended"` when the turn ended while the task still worked. The Slack task card uses it: a task the model cancelled now shows a success check and `Stopped early since it was no longer needed`, and other stopped tasks say why, such as `Stopped by request` or `Stopped when the turn ended`.
