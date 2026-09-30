---
"eve": minor
---

Remove background tasks: workflow tools and subagent calls now always block the turn until they settle, `defineWorkflowTool` rejects `execution`, and `taskDeliveryPolicy`, the `task_cancel` tool, `session.cancel({ tasks })`, task receipts and notifications, and `<eve-empty-delivery/>` are gone. Extensions built against earlier capability epochs must be rebuilt.
