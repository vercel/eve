---
"eve": patch
---

Add `defineLocalSubagent` and `defineRemoteSubagent` with a per-definition `background` option. Both modes use one durable workflow-backed executor, and background execution requires `experimental.tasks: true` on the root agent.
