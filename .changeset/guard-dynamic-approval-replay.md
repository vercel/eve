---
"eve": patch
---

Preserve dynamic tool approval gates when session- and turn-scoped tools are replayed from durable metadata. If a replayed approval callback cannot be recovered, eve now requires approval by default instead of silently running the tool unguarded.
