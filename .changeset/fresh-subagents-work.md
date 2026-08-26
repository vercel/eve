---
"eve": patch
---

Add `defineLocalSubagent` and `defineRemoteSubagent` with per-definition blocking or background execution. Background subagents require the root `experimental.tasks` capability; legacy subagent helpers retain their previous execution behavior and emit migration diagnostics.
