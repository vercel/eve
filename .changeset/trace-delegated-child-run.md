---
"eve": minor
---

Agent call spans now record the child session they delegated to as `agent.child_run.id` and the task they started or continued as `agent.task.id`, so a remote agent's run can be found from the caller's trace, including calls that continue an existing task.

Instrumentation providers receive the same values as `childSessionId` and `taskId` on `call.settled`.
