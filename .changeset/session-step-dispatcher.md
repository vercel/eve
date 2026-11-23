---
"eve": patch
---

eve's session loop and turn now call their durable steps through one step dispatcher on the session host, with the same step names and call order as before.
