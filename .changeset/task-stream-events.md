---
"eve": minor
---

Agent calls and workflow tool calls now appear on the session stream as typed `task.started`, `task.settled`, and `task.ended` events, which replace `subagent.called`, `subagent.started`, and `subagent.completed`. Each piece of work on a task emits one `task.started` (with `generation`, `mode: "attached" | "detached"`, `resumable`, and the agent's `child` stream) and one `task.settled`, and each task emits one `task.ended` when it stops taking input.

Upgrading:

- The `SubagentCalledStreamEvent`, `SubagentStartedStreamEvent`, and `SubagentCompletedStreamEvent` types are replaced by `TaskStartedStreamEvent`, `TaskSettledStreamEvent`, and `TaskEndedStreamEvent`. Pass `task.started` to `session.streamSubagent()`, and subscribe to `task.*` from hooks and channel `events`.
- A delivered result appears as `message.received` with `data.kind: "task.result"` and `data.taskIds`, replacing `data.kind: "execution.background_task"`. Proxied `input.requested`, `approval.*`, and `authorization.*` events carry the child's `taskId`.
- A held turn in an interactive session emits `session.waiting` before its one `turn.completed`, so `session.waiting` no longer always means the turn ended; `turn.completed` does. `send(...).result()` and `t.send()` in evals follow a held turn to its `turn.completed` unless a request they streamed awaits an answer.
- The package ships recorded task streams under `eve/conformance/task-streams/v1/` for contract tests, and eval facts record agent calls from these events.
