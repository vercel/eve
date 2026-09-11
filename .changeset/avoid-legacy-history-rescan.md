---
"eve": patch
---

Avoid an extra full-history scan when restoring durable sessions. Legacy message classification now shares hydration's existing validation pass, while histories written by current versions remain strict.
