---
"eve": minor
---

Standardize authored tools and connections on an `approval` function that receives the active session context and returns AI SDK 7 approval statuses, with synchronous and asynchronous policies supported. Boolean results remain supported as aliases for user approval and no approval, schedules no longer accept approval configuration, and no AI SDK 6 `needsApproval` adapter remains.
