---
"eve": patch
---

eve now loads its platform declaration through one generated platform module, calls the declaration's `context()` when the app starts, and starts the declaration's own durable engine when it gives one.
