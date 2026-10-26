---
"eve": patch
---

A hook that cancels the turn at `compaction.completed` no longer drops the compaction's summary call from the session's usage. `session.waiting` and session limits now count it.
