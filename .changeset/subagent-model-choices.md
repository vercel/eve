---
"eve": patch
---

A declared subagent can set `model: choice(...)` from `eve/models` to let its caller pick a model. The parent passes an optional `model` field when it starts the subagent, and the first choice is the default. The pick lasts for the child's lifetime.
