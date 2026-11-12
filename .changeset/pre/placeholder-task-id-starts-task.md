---
"eve": patch
---

An agent or `serve` tool call whose `taskId` is the placeholder string `"undefined"` or `"null"` now starts a new task instead of failing with `UNKNOWN_TASK`.

Some models send these placeholders instead of omitting the optional `taskId`. An empty `taskId` already started a new task.
