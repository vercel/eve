---
"eve": minor
---

`followAgents: true` now observes child sessions recursively, including workflow-created children, with predicate selection, fixed safety limits, and per-session committed positions and captured-tail progress. `SessionStore.observe()` supports headless capture, and child readers now require source-positioned opening events to verify each local or remote hop through its parent.
