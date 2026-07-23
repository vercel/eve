---
"eve": patch
---

Emit an initial NDJSON whitespace byte when opening a session event stream so clients and proxies receive the response body before the first durable event.
