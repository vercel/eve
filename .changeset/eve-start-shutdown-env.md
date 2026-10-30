---
"eve": patch
---

`eve start` now runs the server's shutdown hooks, such as flushing instrumentation, when it stops the server in an environment that sets `CI`.

The built server no longer inherits `CI` or `NITRO_UNIX_SOCKET` from `eve start`. With `CI` set, Nitro's server skipped its graceful shutdown, and a socket path would make the server ignore the port `eve start` waits on.
