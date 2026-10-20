---
"eve": patch
---

`eve start` now waits for its own built server to report that it bound the requested port. When another process holds the port, it fails with `Port N on H is already in use.` and exits non-zero instead of reporting that process as its ready server.
