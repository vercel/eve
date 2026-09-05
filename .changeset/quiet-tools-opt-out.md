---
"eve": patch
---

Allow agents to set `defaultTools: false` to skip eve's optional default tools while preserving connection discovery and tools explicitly authored under `agent/tools/`. Every optional default can be re-added from its public `eve/tools/*` subpath.
