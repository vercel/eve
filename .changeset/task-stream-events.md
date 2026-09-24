---
"eve": minor
---

Delegated agent calls now appear on the session stream as `task.started` and `task.settled` events, which replace `subagent.called`, `subagent.started`, and `subagent.completed`; the `SubagentCalledStreamEvent`, `SubagentStartedStreamEvent`, and `SubagentCompletedStreamEvent` client types are removed in favor of `TaskStartedStreamEvent` and `TaskSettledStreamEvent`. Every call that starts a task emits one `task.settled` with `status` `completed`, `failed`, or `cancelled`; pass `task.started` to `session.streamSubagent()` (it reads `child.streamPath`), subscribe to `task.*` from hooks and channel `events`, and read `taskId` on proxied `input.requested` and `authorization.*` events. A delivered background result appears as `message.received` with `data.kind: "task.result"` and `data.taskIds`, replacing `data.kind: "execution.background_task"`; consumers that matched the old kind to skip framework deliveries must match `task.result` instead.
