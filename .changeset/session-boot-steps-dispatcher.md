---
"eve": patch
---

eve's session boot, inbox admission, task cancellation and finalization now call their durable steps through the session host's step dispatcher, with the same step names and call order as before.
