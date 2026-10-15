---
"eve": patch
---

A memory provider whose `recall` throws on `turn.started` or `compaction.completed` now fails the turn and leaves the session waiting for the next message, as documented. Previously eve retried the turn step, re-running the recall, and then ended the session with `session.failed`.
