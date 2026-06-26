---
"eve": patch
---

Resuming a durable session that referenced an inbound file attachment no longer fails the turn when the staging sandbox has been torn down. The missing attachment now degrades to a text reference noting the file is unavailable, so the run continues instead of ending in `session.failed`.
