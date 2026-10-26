---
"eve": patch
---

Deliver concurrent messages to the same `ctx.agent()` session in send order, preventing out-of-order delivery from leaving calls waiting indefinitely for a reply.
