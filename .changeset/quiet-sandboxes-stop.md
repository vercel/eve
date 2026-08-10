---
"eve": minor
---

Allow authored hooks, tools, and channel callbacks to stop their active sandbox through `ctx.getSandbox().stop()`. Every built-in backend preserves the durable session for a later callback, and custom sandbox backend handles must now implement `stop()`.
