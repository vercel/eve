---
"eve": patch
---

Workflow tools accept `detach: true`: the call returns a receipt at once (`{ status: "working", taskId }` on `action.result`), and the run's result reaches the model later in one `<task_result>` message, in a result turn when the session is idle or at the next tool step of a turn from the same principal. Background tasks stay listed in the `[Tasks]` note until their results arrive, a session holds at most 10 working ones (`TOO_MANY_BACKGROUND_TASKS`), and subagents and task-mode runs finish only after their background results are delivered. The stream marks delivered results as `message.received` with `kind: "task.result"` and `taskIds`, replacing `kind: "execution.background_task"`, and the client reducer and built-in channels do not render it as a user message. A child session that ends before replying now fails its call with `AGENT_SESSION_ENDED`.
