---
"eve": patch
---

Interrupted durable steps recover from recorded outcomes without automatically replaying observed tool calls. Exhausted turns fail without closing the session, but external effects with unrecorded outcomes still require application-level idempotency.
