---
"eve": minor
---

Agent and task call spans now record the task they started or continued as `agent.task.id`, so the calls that serve one task, including continuations of a remote agent's task, can be grouped in a trace.

Each call also records the call that started its task as `agent.task.started_by_call.id`, so a continuation can be joined to the run that first call started. Instrumentation providers receive both as `taskId` and `taskStartedByCallId` on `call.settled`.
