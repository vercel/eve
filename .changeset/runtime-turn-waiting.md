---
"eve": patch
---

Emit `turn.waiting` with `on: "tasks"` when a model step parks on blocking workflow execute calls, including calls dispatched after approval. Task and agent receipt dispatches do not emit a wait; their actual task waits report the park.
