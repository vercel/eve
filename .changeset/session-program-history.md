---
"eve": patch
---

eve now decides the history each model call reads in one place, before every model call and for `session.compact()`, and compacts as before.

A turn's input now joins history before its first model call, so a model call that fails keeps the person's message for the next turn.
