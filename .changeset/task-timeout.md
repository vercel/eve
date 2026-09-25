---
"eve": minor
---

`defineAgent`, `defineRemoteAgent`, and `defineWorkflowTool` accept `timeout`: the time limit, in milliseconds of active time, for each piece of work on the tool's tasks, or `false` for no limit beyond the session's lifetime. Work still running at its limit fails with `TIMED_OUT`, whose message names the limit, and time spent waiting on a question, approval, or sign-in does not count. A root agent's `timeout` applies to its built-in `agent` copies, and workflow tools default to no limit.

At the limit, eve first reads a workflow tool's run once, so a run that finished but whose outcome was lost settles with that outcome. A local agent that has not stopped 30 seconds after a timeout or cancel has its session terminated and its task ended, and a workflow tool run that has not ended within 35 seconds is stopped outright. A retried start of a workflow tool call no longer runs its body twice.

Upgrading: agent calls, local and remote, now default to a limit of 2 hours of active time, where they had no limit before. An agent whose work runs longer fails with `TIMED_OUT` at 2 hours; set `timeout` on its definition to a larger value, or to `false`.
