---
"eve": patch
---

Propagate dynamic skill resolver errors instead of continuing with stale skills. A turn-start resolver failure now fails the conversation turn before model work and allows a later turn after the source is repaired.
