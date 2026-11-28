---
"eve": patch
---

Let `schedules(definition)` find its source for the export an author imports when one application resolved that module. A module two applications resolve is stamped on a copy per application, which left the imported reference with no source, so `schedules()` in a channel route threw "argument must be a defineDynamicSchedules() definition". A module resolved by several applications is still ambiguous and still has no source.
