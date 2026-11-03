---
"eve": patch
---

A turn's input now joins history before its first model call, so a model call that fails keeps the person's message for the next turn.

A response the provider filters is the exception: a refusal note replaces its turn's input, so the next turn doesn't send that input again. Completed tool calls and their results stay in history, so the model knows which actions already ran.

A compaction now opens only once it summarizes or rewrites the history, so `session.compact()` records no change when its model doesn't resolve or the history has nothing to compact.
