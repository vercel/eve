---
"eve": minor
---

Every agent tool is now a `serve(receive, ctx)` tool built on `ctx.agent`, so every subagent call is a resumable task: the call returns a receipt, the agent's reply arrives as a task result, and the model continues the same agent by passing `taskId` (replacing `agentId`) or stops its current turn with `task_cancel`. The `subagent.called`, `subagent.started`, `subagent.event`, and `subagent.completed` events, their hooks, the `[Agents]` note, and the `AGENT_*` errors are removed; clients, hooks, and evals read `task.started`, `task.settled`, and `agent.started` instead, and `session.streamSubagent()` takes only an `agent.started` event. The default message reducer behind `useEveAgent()` settles a task call's tool part from `task.settled` (output, error, or cancellation) and does not render the appended task result message as a user message.
