---
"eve": patch
---

Expose an immutable completed conversation prefix to workflow tools as `ctx.history`. The captured history excludes the calling tool exchange, letting workflows carry prior context into controlled follow-up work without a session history endpoint.
