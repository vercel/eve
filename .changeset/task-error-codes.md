---
"eve": minor
---

Failed agent and workflow tool work now uses one set of error codes on `task.settled`, the tool result, and `<task_result>`: `START_FAILED` replaces `SUBAGENT_START_FAILED` and `REMOTE_AGENT_START_FAILED`, and `EXECUTION_FAILED` replaces `SUBAGENT_EXECUTION_FAILED`, `REMOTE_AGENT_FAILED`, and a task-mode session's `SESSION_FAILED` callback. An agent that cannot produce its `outputSchema` result fails with `OUTPUT_SCHEMA_NOT_FULFILLED`, one that finishes without a reply fails with `EMPTY_RESULT`, one whose session ends before replying fails with `AGENT_SESSION_ENDED`, and cancelled work carries no error code: `task.settled` reports `status: "cancelled"`.
