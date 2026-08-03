---
"eve": patch
---

Cancelling a turn with running delegated children no longer leaks their handles as permanently `running`. The cancellation epilogue now parks each abandoned child as `"(cancelled)"`, so cancelled children stay resumable and later cancellations no longer stall retrying already-dead children.
