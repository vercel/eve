---
"eve": patch
---

A declared subagent can set `model` to an array of AI Gateway model ids. The parent then passes an optional `model` field when it starts the subagent, and the first entry is the default. The choice lasts for the child's lifetime.
