---
"eve": patch
---

An agent or `serve` tool call with an empty `taskId` now starts a new task instead of failing with `UNKNOWN_TASK`. Some models send `""` for the optional `taskId` rather than omitting it.
