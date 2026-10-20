---
"eve": patch
---

A session keeps accepting messages during a deployment or compaction handoff, so the first message after a handoff reaches the model sooner and messages sent mid-handoff no longer retry or return `409 session_not_ready`; messages already waiting when a compaction finishes now run before the session moves. Sessions started on an earlier eve release still move to this release: their first move uses the previous handoff, and every move after it uses the new one. On Workflow worlds without hook force-claim support, sessions no longer move between runs, so their run history keeps growing for as long as the session lives.
