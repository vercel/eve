---
"eve": patch
---

A memory provider handler that throws on `turn.started`, `compaction.requested` or `compaction.completed` now fails the turn and leaves the session waiting for the next message, as documented. Previously eve retried the turn step, re-running the handler, and then ended the session with `session.failed`.
