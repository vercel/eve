---
"eve": minor
---

Agent calls and workflow tool calls now appear on the session stream as typed `task.started`, `task.settled`, and `task.ended` events, which replace `subagent.called`, `subagent.started`, and `subagent.completed`. Each piece of work on a task emits one `task.started` (with `generation`, `mode: "attached" | "detached"`, `resumable`, and the agent's `child` stream) and one `task.settled`, and each task emits one `task.ended` when it stops taking input.

Upgrading:

- The `SubagentCalledStreamEvent`, `SubagentStartedStreamEvent`, and `SubagentCompletedStreamEvent` types are replaced by `TaskStartedStreamEvent`, `TaskSettledStreamEvent`, and `TaskEndedStreamEvent`. Pass `task.started` to `session.streamSubagent()`, and subscribe to `task.*` from hooks and channel `events`.
- A delivered result appears as `message.received` with `data.kind: "task.result"` and `data.taskIds`, replacing `data.kind: "execution.background_task"`. Proxied `input.requested`, `approval.*`, and `authorization.*` events carry the child's `taskId`.
- Consumers must accept more than one `turn.completed` for one `turnId`: a held turn's waiting boundary carries `held: true`. Skip `message.completed` events with `interim: true` when posting replies. The client's message reducer closes an assistant message at each boundary and marks it `metadata.closed`, and `send(...).result()` follows a held turn to its end.
- The package ships recorded task streams under `eve/conformance/task-streams/v1/` for contract tests, and eval facts record agent calls from these events.
