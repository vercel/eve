---
"eve": patch
---

Runtime-discovered tools now use the same durable validation, callback replay, collision handling, and lifecycle replacement path as authored dynamic tools. Connection tools discovered through `connection_search` keep their existing model-facing behavior while resuming approval and authorization callbacks reliably after a process restart.
