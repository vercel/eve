---
"eve": minor
---

Replace authored background-tool delegation callbacks with durable generator yields. Background tools now use `task.setState()` for model-visible state and `task.postMessage()` for explicit parent wakes; ordinary yields are stream-only progress, and returning or throwing settles the task.
