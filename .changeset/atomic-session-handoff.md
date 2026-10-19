---
"eve": patch
---

A session keeps accepting messages during a deployment or compaction handoff, so the first message after a handoff reaches the model sooner and messages sent mid-handoff no longer retry or return `409 session_not_ready`; messages already waiting when a compaction finishes now run before the session moves. On Workflow worlds without hook force-claim support, sessions no longer move between runs, so their run history keeps growing for as long as the session lives.
