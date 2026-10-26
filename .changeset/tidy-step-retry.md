---
"eve": patch
---

Interrupted durable steps recover from recorded outcomes without automatically replaying observed tool calls. Exhausted step retries fail the turn without closing the session, but external effects with unrecorded outcomes still require application-level idempotency.
