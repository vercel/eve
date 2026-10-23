---
"eve": patch
---

`eve dev` no longer answers an occasional request with 503 `socket hang up` or `read ECONNRESET` under heavy CPU load. Each request now reaches the dev worker on its own connection instead of a pooled one the worker may have just closed.
