---
"eve": minor
---

Remove `task.delegated()` and replace authored background-tool delegation callbacks with durable generator yields; extensions using the removed API must migrate and rebuild. Background tools now use `task.postMessage()` for explicit parent wakes; ordinary yields are stream-only progress, and returning or throwing settles the task.
