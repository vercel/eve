---
"eve": patch
---

Fix an extension mounted in several agents with different configs, for example at the root and inside a declared subagent, giving every agent the config of whichever mount loaded last. `extension.config` now returns the config of the mount serving the current session's agent. Subagents an extension ships inherit the config of the agent that mounts it.
