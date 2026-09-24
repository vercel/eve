---
"eve": patch
---

Report delegated agent usage, including `costUsd`, on instrumentation `action.completed` and `action.failed` events for background agent tasks. These tasks now carry their settled usage instead of omitting it; blocking workflow-tool subagent calls remain outside this coverage.
