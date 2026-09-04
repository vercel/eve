---
"eve": patch
---

Hooks can inspect a completed conversation turn with `beforeResponseRelease` and restore model history to an earlier index before terminal channel delivery. Restoring history suppresses the pending response while preserving earlier events and external side effects.
