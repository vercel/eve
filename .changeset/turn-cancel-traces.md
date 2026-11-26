---
"eve": patch
---

Cancelling a turn no longer records the tools and model calls it stops as exceptions in traces.

Tools and model calls stopped by a turn cancellation now end their spans as cancelled, so error tracking no longer counts each cancel as a failure.
