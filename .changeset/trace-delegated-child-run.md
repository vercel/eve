---
"eve": minor
---

Agent and task call spans now record the task they started or continued as `agent.task.id`, so the calls that serve one task, including continuations of a remote agent's task, can be grouped in a trace.

Instrumentation providers receive the same value as `taskId` on `call.settled`.
