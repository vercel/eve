---
"eve": patch
---

Delegated agent calls now appear on the session stream as `task.started` and `task.settled` events, which replace `subagent.called`, `subagent.started`, and `subagent.completed`. Every call that starts a task emits one `task.settled` with `status` `completed`, `failed`, or `cancelled`; pass `task.started` to `session.streamSubagent()` (it reads `child.streamPath`), subscribe to `task.*` from hooks and channel `events`, and read `taskId` on proxied `input.requested` and `authorization.*` events.
