---
"eve": minor
---

Root workflow tools now receive the built-in root-copy target at `ctx.agents.agent`, with its authored description or an empty string, and `agent` is reserved from use as a declared subagent name. Tool definitions can set `availableInSubagents: false`; `agentRouter()` sets it automatically, routes only to entries with non-empty descriptions, and can replace the model-facing tool at `agent/tools/agent.ts` without being inherited by the root copy.
