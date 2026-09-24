---
"eve": minor
---

Failed agent and workflow tool calls use one set of error codes on `task.settled`, the tool result, and `<task_result>`. `START_FAILED` replaces `SUBAGENT_START_FAILED` and `REMOTE_AGENT_START_FAILED` for a child that cannot start, and `EXECUTION_FAILED` replaces `SUBAGENT_EXECUTION_FAILED`, `REMOTE_AGENT_FAILED`, and the `SESSION_FAILED` of a task-mode session's failed callback for work that fails without a code of its own. An agent that cannot produce its `outputSchema` result fails with `OUTPUT_SCHEMA_NOT_FULFILLED`, and one that finishes without a reply fails with `EMPTY_RESULT`. A cancelled agent call no longer carries an error code: `task.settled` reports `status: "cancelled"`, and a waited call's error result is the cancellation message alone, as for a cancelled workflow tool call.
