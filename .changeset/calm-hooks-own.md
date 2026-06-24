---
"eve": patch
---

Confirm continuation-token ownership before an agent turn starts or a session re-keys. Competing sessions now fail before processing input, and successful delivery reports the hook owner atomically.
