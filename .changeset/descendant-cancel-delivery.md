---
"eve": patch
---

Cancelling a parent turn now delivers descendant cancellations more reliably: the cancel request retries with exponential backoff (~8s budget instead of 3s), `no_active_turn` results carry the error class that marked the target inactive, and every previously silent drop path (missing pending batch, missing child session ids, exhausted retries) now logs a warning so an uncancelled child no longer runs to completion without a trace.
