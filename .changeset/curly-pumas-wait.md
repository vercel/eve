---
"eve": patch
---

Preserve a session-scoped dynamic model selection when the first turn is cancelled so later turns can reuse it without requiring a `turn.started` resolver.
