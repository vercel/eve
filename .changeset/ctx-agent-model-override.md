---
"eve": patch
---

Allow authored workflow tools to select an AI Gateway model when they open a local session with `ctx.agent()`. The child keeps the target agent's other configuration, and the selected model applies for the session's lifetime.
