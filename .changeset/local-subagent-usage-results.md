---
"eve": patch
---

Local and runtime subagents now report their token usage back to the caller. A delegated subagent's terminal result carries the child session's token totals, and the parent's turn emits an `invoke_agent` span (`gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.usage.*`) in the caller's trace so parent-side observability can attribute each child agent's tokens. This complements the remote-agent usage callback: together, every subagent type reports usage to its caller.
