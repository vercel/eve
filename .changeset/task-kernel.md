---
"eve": minor
---

A workflow tool now defines exactly one of `execute(input, ctx)` or `task(input, ctx)`. A `task` tool runs each call as a task: the model gets a receipt at once, the result arrives later in a `task.result` message, the model waits with `task_wait` or stops a task with `task_cancel`, and a turn can't end while its tasks work. `agentRouter()` and the `workflow` tool now run as tasks. The stream reports `task.started` and `task.settled` with each call's `turnId`, `turn.waiting` while `task_wait` waits, and the `taskId` on `agent.started` for a session a task opens; task results are not published as `message.received`. `session.cancel()` also stops working tasks, and `execution` now fails with a pointer to `task()`. Authored tools can no longer be named `task_wait` or `task_cancel`. Consecutive queued messages from one principal now share a turn even when their auth claims changed, and the turn runs with the latest claims.
