---
"eve": minor
---

Remove background task execution. Every tool call, including subagent calls and workflow tools, now finishes inside the turn that made it, and the model receives the result as the tool result instead of a task receipt followed by a later notification. `task_cancel`, `taskDeliveryPolicy`, `execution: "background"`, `TaskReceipt`, and the `taskId`/`tasks` options of `session.cancel()` are removed.
