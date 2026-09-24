---
"eve": patch
---

Report delegated agent usage, including `costUsd`, on instrumentation `action.completed` and `action.failed` events for subagents and background agent tasks. Background agent tasks now carry their settled usage instead of omitting it.
