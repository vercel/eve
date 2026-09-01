---
"eve": patch
---

Spans held for a parent that never ends are no longer lost or buffered without bound: eve's span-filtering processor now drains them to destinations on `forceFlush` and `shutdown`, and caps how many a stuck parent can hold.
