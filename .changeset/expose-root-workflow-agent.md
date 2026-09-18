---
"eve": minor
---

Root workflow tools now receive the built-in root-copy target at `ctx.agents.agent`, using the root agent's authored description when available. `agentRouter()` considers the same root-copy target without exposing it recursively, and `agent` is now reserved from use as a declared subagent name.
