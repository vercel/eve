---
"eve": minor
---

Remove background task execution. Every tool call, including subagent calls and workflow tools, now finishes inside the turn that made it, and the model receives the result as the tool result instead of a task receipt followed by a later notification. `task_cancel`, `taskDeliveryPolicy`, `execution: "background"`, `TaskReceipt`, and the `taskId`/`tasks` options of `session.cancel()` are removed; delete any `agent/tools/task_cancel.ts` file. Stream consumers no longer receive `message.received.kind` or `subagent.completed.backgroundTask`. Upgrade remote agents and the agents that call them together.
