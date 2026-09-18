---
"eve": patch
---

Root workflow tools now receive the built-in root-copy target at `ctx.agents.agent`, using the root agent's authored description when available. `agentRouter()` considers the same root-copy target that `ctx.agent("agent", ...)` can invoke.
