---
"eve": patch
---

Cancelling a turn while the model is responding no longer marks its `agent.step` span as an error, so user-initiated stops stop showing up as failures in error tracking.
