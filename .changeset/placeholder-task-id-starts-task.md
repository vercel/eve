---
"eve": patch
---

An agent or `serve` tool call whose `taskId` is the placeholder string `"undefined"` or `"null"` now starts a new task instead of failing with `UNKNOWN_TASK`.

Some models send these placeholders for the optional `taskId` rather than omitting it, as others send `""`, which already starts a new task.
