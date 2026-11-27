---
"eve": patch
---

Allow `waitUntil()` work scheduled by `session.started` and `delivery.admitted` handlers to run concurrently with the first model call instead of draining before the turn starts.
