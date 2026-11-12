---
"eve": patch
---

Explain more prominently that `defineDynamic` functions run before every model call, so network requests, database queries, API calls, and sandbox reads belong inside `ctx.memo`.
