---
"eve": minor
---

Agents and `resumable: true` workflow tools now take more input by `taskId`: calling the tool again with a task's `taskId` sends that task a correction or its next piece of work, validated by the tool's own input schema. A resumable workflow body reads each send with `ctx.receive()` and settles each piece of work with one `ctx.reply()`.

Upgrading:

- `agentId` is renamed `taskId` on every agent tool and in `ctx.agent` input, and task IDs look like `researcher-7k2m9q`. A `taskId` the session does not have fails with `UNKNOWN_TASK` instead of starting a new agent.
- `AGENT_MISMATCH`, `AGENT_BUSY`, and `AGENT_UNREACHABLE` are renamed `TASK_MISMATCH`, `TASK_BUSY`, and `TASK_UNREACHABLE`. A send to a task another principal started fails with `TASK_OTHER_PRINCIPAL`, and a task holds at most 20 sends it has not read.
- `ctx.agent` accepts an optional `signal` whose abort cancels that call's task. When a workflow call ends, by returning or by `ctx.reply`, eve cancels the agent tasks it still owns.
- A session keeps at most 50 idle tasks, agents and resumable workflow tools alike; past that, eve ends the least recently started ones.
