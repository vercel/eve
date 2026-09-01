---
"eve": patch
---

Internal subagent execution now lives under a dedicated source tree, separating executor implementation from the task kernel. Workflow bundles include this tree so durable executor steps remain registered.
