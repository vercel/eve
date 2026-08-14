---
"eve": minor
---

Replace `stop()` on frontend agent bindings with `cancel()`. Cancellation now targets the exact durable turn through `MessageResponse.cancel()` while the binding stays attached through settlement.
