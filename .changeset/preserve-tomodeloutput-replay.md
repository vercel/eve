---
"eve": patch
---

Preserve toModelOutput when session- and turn-scoped dynamic tools are replayed from durable metadata, so the model keeps seeing the shaped view instead of the raw execute output. If the registered hook cannot be recovered on replay, the raw output is withheld from the model rather than passed through.
