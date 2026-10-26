---
"eve": minor
---

`followAgents: true` now observes child sessions recursively, including workflow-created children, with predicate selection, bounded traversal, and per-session positions and progress. `SessionStore.observe()` supports headless capture; child readers require source-positioned opening events to verify each hop through its parent.
