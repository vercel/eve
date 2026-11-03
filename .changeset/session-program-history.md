---
"eve": patch
---

A turn's input now joins history before its first model call, so a model call that fails keeps the person's message for the next turn. A response the provider filters is the exception: its turn's input leaves history, so the next turn doesn't send it again.

A compaction now opens only once it summarizes or rewrites the history, so `session.compact()` records no change when its model doesn't resolve or the history has nothing to compact.
