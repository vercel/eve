---
"eve": patch
---

Deduplicate concurrent `ctx.getToken()` calls for the same auth scope and principal within a step.
