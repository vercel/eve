---
"eve": patch
---

In an interactive root session, agent tools (the built-in `agent`, declared, dynamic, and remote subagents) now accept `background: true`: the call returns a receipt at once, and the agent's answer arrives later in its own `task.result` message. Background agent calls count toward the 10 working background tasks and fail with `TOO_MANY_BACKGROUND_TASKS` over the limit; subagent sessions and task-mode runs do not offer the parameter, and a turn a schedule starts waits instead. Passing the `agentId` of an agent that is still working now sends it a message that joins its current call and returns a receipt; only the principal that started the agent's current work can do so, and a call naming an agent a workflow body is waiting on fails with `AGENT_BUSY`.
