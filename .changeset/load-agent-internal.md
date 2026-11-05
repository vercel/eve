---
"eve": patch
---

eve can read an `agent/` directory as an agent defined in code, internally, through `loadAgent(dir)`, which declares what `defineAgent` would from its files; agents built and deployed with `eve build` are unchanged.
