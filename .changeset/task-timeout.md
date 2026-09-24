---
"eve": patch
---

`defineAgent`, `defineRemoteAgent`, and `defineWorkflowTool` accept `timeout`: the time limit for each call, in milliseconds, or `false` for no limit beyond the session's lifetime. A call still working at its limit fails with `TIMED_OUT`. Agents default to 2 hours of active time, and a root agent's `timeout` applies to its built-in `agent` copies; workflow tools default to no limit. A cancelled workflow tool run that has not ended 35 seconds after the cancel is stopped outright, and a retried start of a workflow tool call no longer runs its body twice.
