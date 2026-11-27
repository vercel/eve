---
"eve": minor
---

Add `getCurrentAuth()` to `eve/context`. It returns the caller of the session the running code belongs to, or `undefined` outside eve-run code, so a library that serves several callers from one process can tell which one it is serving without being handed the context.
