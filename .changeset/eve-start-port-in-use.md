---
"eve": patch
---

`eve start` now fails with a clear error when another process already holds the requested port, instead of printing `server listening` for a server it did not start.
